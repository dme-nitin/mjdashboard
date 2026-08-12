/******************************************************
 * GLOBAL MEDICARE — RSM DASHBOARD   Code.gs  v21
 *
 * CONFIRMED SHEET LAYOUT (Report tab):
 *
 *   SCORECARD       Report!A2:F6
 *   PIPELINE STAGE  Report!H1:N5
 *   DEMO ACTIVITY   Report!P1:R6
 *   UNIQUE CUST     Report!AR1:AT6
 *   LEADS           Report!AD2:AI
 *
 *   CUSTOMER-PRODUCT MAP  Report!AV:AY  (confirmed Image 2)
 *     AV (col 48) = Timestamp            ← SKIP
 *     AW (col 49) = Hospital Name
 *     AX (col 50) = Demo Product         ← comma-separated
 *     AY (col 51) = State
 *
 *   PRODUCT PRICE LIST  Report!AZ:BA  (confirmed Image 2)
 *     AZ (col 52) = Product Name
 *     BA (col 53) = Price per unit
 *
 *   SALES EXECUTIVE DETAIL  Report!BR:BW
 *     BR (col 70) = Timestamp
 *     BS (col 71) = Email address        ← filter key
 *     BT (col 72) = Hospital Name
 *     BU (col 73) = City
 *     BV (col 74) = Demo Product
 *     BW (col 75) = RSM Name
 *
 *  v21 CHANGE LOG (Demo Trend fix only):
 *    - parseSheetTimestamp(): hardened to also handle AM/PM
 *      suffixes, dot/dash separators, non-breaking spaces, and
 *      numeric spreadsheet serial dates, so no row silently
 *      fails to parse.
 *    - computeDemoTrend(): RSM Name from column W is now passed
 *      through canonicalRsmName() so case/whitespace variants
 *      ("daya ", "DAYA") still land in the correct bucket
 *      instead of silently forming an invisible extra group.
 *    - No other function changed. JSON shape returned to the
 *      frontend is identical to before.
 ******************************************************/

var REPORT_TAB    = "Report";
var CACHE_KEY     = "gm_dash_v56";
var CACHE_SECONDS = 60;
var RSM_NAMES     = ["Daya", "Vijay", "Abhishek Tiwari", "Tanmoy", "Giridharan"];

/* ══════════════════════════════════════════════════
   RSM_DIRECT_EMAILS
   The 5 RSMs' OWN email addresses — separate from
   SALES_EXECUTIVES (which only lists their SUBORDINATE sales
   reps). If an RSM personally logs a demo or hospital visit,
   THEIR OWN email appears in the Sales Executive ID column
   (Report!R / Report!AT) — without this map, such rows would
   silently fail to match any RSM and get dropped/undercounted.

   IMPORTANT: values here MUST exactly match RSM_NAMES above
   (e.g. "Abhishek Tiwari", not "Abhishek") — a mismatched name
   here would map to a bucket that doesn't exist and the row
   would still be silently lost.
══════════════════════════════════════════════════ */
var RSM_DIRECT_EMAILS = {
  "daya.shanker@globalmedicare.co.in" : "Daya",
  "vija@globalmedicare.co.in"         : "Vijay",
  "tanmoy@globalmedicare.co.in"       : "Tanmoy",
  "giridharan@globalmedicare.co.in"   : "Giridharan",
  "abhishek@globalmedicare.co.in"     : "Abhishek Tiwari"
};

/* ══════════════════════════════════════════════════
   buildEmailToRsmLookup()
   THE single, shared email → RSM lookup used everywhere in this
   file (computeDemoActivityRaw, computeUniqueAddedRaw,
   getUniqueAddedThisMonthReport, etc.) — combines:
     1. SALES_EXECUTIVES (subordinate sales reps → their RSM)
     2. RSM_DIRECT_EMAILS (an RSM's own email → themselves)
   Building this in exactly ONE place means a fix here (like
   adding a missing email) automatically applies everywhere,
   instead of needing the same fix repeated in multiple
   independently-built lookup objects (which is how this kind of
   bug happens in the first place).
   Returns: { "email@x.com": "RsmName", ... } (lowercased keys)
══════════════════════════════════════════════════ */
function buildEmailToRsmLookup() {
  var rsmByEmail = {};
  SALES_EXECUTIVES.forEach(function(ex) {
    var e = String(ex.email || "").trim().toLowerCase();
    if (e) rsmByEmail[e] = ex.rsm;
  });
  Object.keys(RSM_DIRECT_EMAILS).forEach(function(email) {
    rsmByEmail[email.trim().toLowerCase()] = RSM_DIRECT_EMAILS[email];
  });
  return rsmByEmail;
}

/* ══════════════════════════════════════════════════
   getCurrentWeekMonToSat()
   THE single, shared "current week" boundary used EVERYWHERE in
   this file that has a week-based metric (RSM Scorecards'
   Demos/Unique Cust, Sales Executive Reports' Demo Done/Unique
   Added, Accounts' Weekly Payments, etc.) — one function, one
   definition, so there's never a mismatch between sections again.

   Definition (per explicit requirement):
     Week = Monday → Saturday of the CURRENT, still-in-progress
     week (NOT the last completed week, and Sunday is EXCLUDED
     entirely — never counted in "this week").

   Example: today = Fri 31/07/2026 → week = Mon 27/07/2026
   through Sat 01/08/2026 (crosses into August — that's expected,
   the week is whatever calendar days it spans).

   If today itself IS a Sunday, that Sunday belongs to no week —
   the function returns the Mon–Sat week that just finished
   (yesterday was its Saturday), since Sunday is never "in" a week.

   Returns: { start: Date (Mon 00:00:00.000), end: Date (Sat 23:59:59.999) }
══════════════════════════════════════════════════ */
function getCurrentWeekMonToSat() {
  var now = new Date();
  var dow = now.getDay(); /* 0=Sun, 1=Mon, ..., 6=Sat */
  var daysSinceMonday = (dow === 0) ? 6 : (dow - 1);
  var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
  monday.setHours(0, 0, 0, 0);
  var saturday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 5);
  saturday.setHours(23, 59, 59, 999);
  return { start: monday, end: saturday };
}

/* ══════════════════════════════════════════════════
   SALES EXECUTIVE DIRECTORY (dropdown source of truth)
══════════════════════════════════════════════════ */
/* RSM hierarchy order — dropdown groups must render in exactly this order */
var RSM_HIERARCHY_ORDER = ["Vijay", "Daya", "Abhishek Tiwari", "Giridharan", "Tanmoy"];

var SALES_EXECUTIVES = [
  /* ── Vijay ── */
  {email:"amitthakurglobalmedicare@gmail.com",   name:"Amit",          rsm:"Vijay"},
  {email:"shaneshwarglobalmedicare@gmail.com",   name:"Shaneshwar",    rsm:"Vijay"},
  {email:"arifaltafglobalmedicare@gmail.com",    name:"Arif",          rsm:"Vijay"},
  {email:"harunglobalmedicare@gmail.com",        name:"Harun",         rsm:"Vijay"},
  {email:"jugaljodhpurglobalmedicare@gmail.com", name:"Jugal",         rsm:"Vijay"},
  {email:"rajinderglobalmedicare@gmail.com",     name:"Rajinder",      rsm:"Vijay"},
  {email:"ahamadafzalglobalmedicare@gmail.com",  name:"Afzal",         rsm:"Vijay"},

  /* ── Daya ── */
  {email:"muskanglobalmedicare@gmail.com",       name:"Muskan",        rsm:"Daya"},
  {email:"ashrafglobalmedicare@gmail.com",       name:"Ashraf",        rsm:"Daya"},
  {email:"ranjanglobalmedicare@gmail.com",       name:"Ranjan",        rsm:"Daya"},
  {email:"arungloballko@gmail.com",              name:"Arun",          rsm:"Daya"},
  {email:"pintuglobalmedicare@gmail.com",        name:"Pintu",         rsm:"Daya"},
  {email:"pankajglobalmedicare@gmail.com",       name:"Pankaj",        rsm:"Daya"},

  /* ── Abhishek Tiwari ── */
  {email:"tausifglobalmedicare@gmail.com",       name:"Tausif",        rsm:"Abhishek Tiwari"},
  {email:"tkamlesh2018@gmail.com",               name:"Kamlesh",       rsm:"Abhishek Tiwari"},
  {email:"gauravb.globalmedicare@gmail.com",     name:"Gaurav",        rsm:"Abhishek Tiwari"},
  {email:"akashglobalmedicare@gmail.com",        name:"Akash Patel",   rsm:"Abhishek Tiwari"},

  /* ── Giridharan ── */
  {email:"hemchandanglobalmedicare@gmail.com",   name:"Hemchandan",    rsm:"Giridharan"},
  {email:"arunchennaiglobalmedicare@gmail.com",  name:"Arun Chennai",  rsm:"Giridharan"},
  {email:"rajenderreddyglobalmedicare@gmail.com",name:"Rajender Reddy",rsm:"Giridharan"},

  /* ── Tanmoy ── */
  {email:"sudiptaglobalmedicare@gmail.com",      name:"Sudipta",       rsm:"Tanmoy"},
  {email:"dibakarglobalmedicare@gmail.com",      name:"Dibakar",       rsm:"Tanmoy"},
  {email:"rohitglobalmedicare@gmail.com",        name:"Rohit",         rsm:"Tanmoy"}
];

/* ══════════════════════════════════════════════════
   WEB APP ENTRY POINT
══════════════════════════════════════════════════ */
function doGet(e) {
  var cb        = e && e.parameter && e.parameter.callback;
  var execEmail = e && e.parameter && e.parameter.exec;
  var section   = e && e.parameter && e.parameter.section;
  var page      = e && e.parameter && e.parameter.page;

  /* ── New: Accounts page — visited via ?page=accounts, opened in a new tab
     from the "Accounts" button next to the RSM filters. Separate HTML file,
     does not touch any existing routing below. ── */
  if (page === "accounts") {
    return loadAccountsPage();
  }

  /* ── Direct test: visit [url]?section=demoTrend to see raw backend output ── */
  if (section === "demoTrend") {
    var td = computeDemoTrend();
    var out = JSON.stringify({ demoTrend: td, rowCount: td._rowCount, keys: Object.keys(td) });
    if (cb) return ContentService.createTextOutput(cb + "(" + out + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugInventory to see the raw
     Report!DY:EA values plus font weight/color/background for each
     row, so we can identify exactly which formatting signal marks a
     "company header" row vs an "item" row. ── */
  if (section === "debugInventory") {
    var rep2 = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var dbgRows = [];
    if (rep2) {
      var lastRow2 = rep2.getLastRow();
      if (lastRow2 >= 2) {
        var numRows2 = Math.min(lastRow2 - 1, 40);
        var range2      = rep2.getRange(2, 129, numRows2, 3);
        var values2     = range2.getValues();
        var weights2    = range2.getFontWeights();
        var colors2     = range2.getFontColors();
        var backgrounds2 = range2.getBackgrounds();
        for (var di = 0; di < values2.length; di++) {
          dbgRows.push({
            row        : di + 2,
            DY         : values2[di][0],
            DZ         : values2[di][1],
            EA         : values2[di][2],
            fontWeight : weights2[di][0],
            fontColor  : colors2[di][0],
            background : backgrounds2[di][0]
          });
        }
      }
    }
    var dbgOut = JSON.stringify({ rows: dbgRows });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgOut).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Current Bank card data — used by the frontend's JSONP fallback path
     (when the page isn't running inside the HtmlService google.script.run
     sandbox). Same data as getCurrentBankData(), just JSONP-wrapped. ── */
  if (section === "currentBank") {
    var bankData = getCurrentBankData();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(bankData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(bankData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Payment Summary (Kamaljeet/Varsha) — used by the frontend's JSONP
     fallback path. ── */
  if (section === "paymentSummaryByEmployee") {
    var psData = getPaymentSummaryByEmployee();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(psData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(psData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Expected Payment Receive This Week — used by the frontend's JSONP
     fallback path. Same data as getWeeklyPayments(), just JSONP-wrapped. ── */
  if (section === "weeklyPayments") {
    var wpData = getWeeklyPayments();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(wpData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(wpData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Total Amount Receive This Month — used by the frontend's JSONP
     fallback path. Same data as getTotalAmountReceivedThisMonth(). ── */
  if (section === "totalAmountReceivedThisMonth") {
    var tarData = getTotalAmountReceivedThisMonth();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(tarData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(tarData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Accounts Receivable — used by the frontend's JSONP
     fallback path. Same data as getAccountsReceivable(). ── */
  if (section === "accountsReceivable") {
    var arData = getAccountsReceivable();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(arData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(arData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Expected Payment Receive This Month — used by the frontend's JSONP
     fallback path. Same data as getMonthlyPayments(), just JSONP-wrapped. ── */
  if (section === "monthlyPayments") {
    var mpData = getMonthlyPayments();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(mpData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(mpData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Overdue Invoices (3–6 Months) — used by the frontend's JSONP
     fallback path. Same data as getOverdueInvoices(), just JSONP-wrapped. ── */
  if (section === "overdueInvoices") {
    var oiData = getOverdueInvoices();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(oiData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(oiData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Overdue Invoices (Over 6 Months) — used by the frontend's JSONP
     fallback path. Same data as getOverdue6PlusMonths(), just JSONP-wrapped. ── */
  if (section === "overdue6Plus") {
    var oi6Data = getOverdue6PlusMonths();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(oi6Data) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(oi6Data)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Expenses Going Over Budget — used by the frontend's JSONP
     fallback path. Same data as getOverBudgetExpenses(), just JSONP-wrapped. ── */
  if (section === "overBudget") {
    var obData = getOverBudgetExpenses();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(obData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(obData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Inventory - Item Wise — used by the frontend's JSONP
     fallback path. Same data as getInventoryItemWise(), just JSONP-wrapped. ── */
  if (section === "inventoryItemWise") {
    var invData = getInventoryItemWise();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(invData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(invData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── This Month Sale — direct test route. Normally this data
     travels inside the main getDashboardData() payload, but this
     route lets you check it in isolation, e.g.
     ?section=thisMonthSale ── */
  if (section === "thisMonthSale") {
    var tmsData = getThisMonthSale();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(tmsData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(tmsData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Monthly Cashflow — used by the frontend's JSONP
     fallback path. Same data as getMonthlyCashflow(), just JSONP-wrapped. ── */
  if (section === "monthlyCashflow") {
    var cfData = getMonthlyCashflow();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(cfData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(cfData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Target Vs Achievement — used by the frontend's JSONP
     fallback path. Same data as getTargetVsAchievement(), just JSONP-wrapped. ── */
  if (section === "targetVsAchievement") {
    var tvaForce = e.parameter.forceRefresh === "1";
    var tvaData = getTargetVsAchievement(tvaForce);
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(tvaData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(tvaData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── HR Summary (Total Hiring / Completed / Pending) — used by
     the frontend's JSONP fallback path. ── */
  if (section === "hrSummary") {
    var hrData = getHRSummary();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(hrData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(hrData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Sales Executive Detail report (Report!EZ:FL) — used by
     the frontend's JSONP fallback path. ── */
  if (section === "salesExecDetailReport") {
    var sedData = getSalesExecDetailReport();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(sedData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(sedData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugSalesExecDetail to
     see the RAW Report!EZ:FL values (with their JS typeof) plus
     what isTruthyCheckbox() decides for each product cell — use
     this to confirm exactly what the sheet is really returning,
     instead of guessing. ── */
  if (section === "debugSalesExecDetail") {
    var repSED = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var dbgSedRows = [];
    if (repSED) {
      var lastRowSED = repSED.getLastRow();
      if (lastRowSED >= 2) {
        var numRowsSED = Math.min(lastRowSED - 1, 15);
        var rangeSED = repSED.getRange(2, 156, numRowsSED, 13); /* EZ=156, 13 cols through FL=168 */
        var valuesSED = rangeSED.getValues();
        for (var di = 0; di < valuesSED.length; di++) {
          var rv = valuesSED[di];
          if (!String(rv[0] || "").trim()) continue; /* skip blank rows */
          var productDebug = {};
          for (var pi = 0; pi < SALES_EXEC_TRAINING_PRODUCTS.length; pi++) {
            var rawCell = rv[3 + pi];
            productDebug[SALES_EXEC_TRAINING_PRODUCTS[pi]] = {
              raw    : rawCell,
              typeof : typeof rawCell,
              isTruthyCheckbox_result : isTruthyCheckbox(rawCell)
            };
          }
          dbgSedRows.push({
            row              : di + 2,
            name             : rv[0],
            doj_raw          : rv[1],
            physicalTraining_raw : rv[2],
            products         : productDebug
          });
        }
      }
    }
    var dbgSedOut = JSON.stringify({ rows: dbgSedRows });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgSedOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgSedOut).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugThisMonthSaleColors
     to see every current-month EU (Model) cell's raw background
     hex, alongside what classifyEuBgColor() decided (white/
     yellow/red) — use this to confirm the color grouping is
     matching the real sheet, and tune classifyEuBgColor()'s RGB
     thresholds if a color is being misclassified. ── */
  if (section === "debugThisMonthSaleColors") {
    var repTms = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var dbgTmsRows = [];
    if (repTms) {
      var lastRowTms = repTms.getLastRow();
      if (lastRowTms >= 2) {
        var nowTms = new Date();
        var curMonthTms = nowTms.getMonth();
        var curYearTms  = nowTms.getFullYear();
        var rangeTms = repTms.getRange(2, 147, lastRowTms - 1, 8); /* EQ=147, 8 cols through EX=154 */
        var valuesTms = rangeTms.getValues();
        var bgTms     = rangeTms.getBackgrounds();
        for (var ti = 0; ti < valuesTms.length; ti++) {
          var billDateTms = parseSheetTimestamp(valuesTms[ti][0]);
          var inMonth = billDateTms ? (billDateTms.getMonth() === curMonthTms && billDateTms.getFullYear() === curYearTms) : false;
          var modelTms = String(valuesTms[ti][4] || "").trim();
          if (!modelTms) continue;
          dbgTmsRows.push({
            row           : ti + 2,
            model         : modelTms,
            amount        : valuesTms[ti][3],
            inCurrentMonth: inMonth,
            euBackground  : bgTms[ti][4],
            classifiedAs  : classifyEuBgColor(bgTms[ti][4])
          });
        }
      }
    }
    var dbgTmsOut = JSON.stringify({ rows: dbgTmsRows });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgTmsOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgTmsOut).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugKpiValues to see the
     3 new dashboard KPI values (Current Bank, Expected Payment
     This Month, Overdue 6+ Months) computed FRESH — this
     completely bypasses getDashboardData()'s 60-second cache, so
     if these show real numbers here but ₹0 on the dashboard, the
     dashboard is just serving a stale cached payload from before
     these fields existed (fix: click "Refresh Data", or wait 60s
     and reload). If these are 0 here too, the underlying Accounts
     data itself needs checking. ── */
  if (section === "totalSaleYtdRows") {
    var totalSaleRowsData = getTotalSaleYtdRows();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(totalSaleRowsData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(totalSaleRowsData)).setMimeType(ContentService.MimeType.JSON);
  }

  if (section === "poInHand") {
    var poData = getPoInHand();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(poData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(poData)).setMimeType(ContentService.MimeType.JSON);
  }

  if (section === "saleTrendProductWise") {
    var trendData = getSaleTrendProductWise();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(trendData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(trendData)).setMimeType(ContentService.MimeType.JSON);
  }

  if (section === "uniqueAddedThisMonthReport") {
    var uaReportData = getUniqueAddedThisMonthReport();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(uaReportData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(uaReportData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugPoInHand to see the
     RAW Report!FP:FU values for the first 15 non-blank rows —
     use this to confirm the Hospital/Product/Quantity/Amount
     column mapping in getPoInHand() actually matches the sheet. ── */
  if (section === "debugPoInHand") {
    var repPo = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var dbgPoRows = [];
    if (repPo) {
      var lastRowPo = repPo.getLastRow();
      if (lastRowPo >= 2) {
        var numRowsPo = Math.min(lastRowPo - 1, 15);
        var valuesPo = repPo.getRange(2, 172, numRowsPo, 6).getValues(); /* FP=172, 6 cols through FU=177 */
        for (var pi = 0; pi < valuesPo.length; pi++) {
          if (!String(valuesPo[pi][0] || "").trim()) continue;
          dbgPoRows.push({
            row : pi + 2,
            FP  : valuesPo[pi][0],
            FQ  : valuesPo[pi][1],
            FR  : valuesPo[pi][2],
            FS  : valuesPo[pi][3],
            FT  : valuesPo[pi][4],
            FU  : valuesPo[pi][5]
          });
        }
      }
    }
    var dbgPoOut = JSON.stringify({ rows: dbgPoRows });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgPoOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgPoOut).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugDemoUniqueScorecard
     to see the RAW Report!P:R (Demo, first 15 non-blank rows) and
     AR:AT (Unique Added, first 15 non-blank rows) values, each
     row's parsed date + RSM lookup result (or "UNMAPPED EMAIL" if
     the email isn't found in SALES_EXECUTIVES), PLUS the final
     computed per-RSM week/month numbers — this bypasses the
     60-second dashboard cache entirely, so it always reflects the
     sheet's CURRENT state, live. ── */
  if (section === "debugDemoUniqueScorecard") {
    var repDbg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var dbgDemoRows = [], dbgUniqRows = [];
    if (repDbg) {
      var lastRowDbg = repDbg.getLastRow();
      if (lastRowDbg >= 2) {
        var rsmByEmailDbg = buildEmailToRsmLookup();

        /* P:R sample (Demo) — P=16, 3 cols */
        var demoValsDbg = repDbg.getRange(2, 16, Math.min(lastRowDbg - 1, 200), 3).getValues();
        for (var di = 0; di < demoValsDbg.length && dbgDemoRows.length < 15; di++) {
          var emailD = String(demoValsDbg[di][2] || "").trim();
          if (!emailD) continue;
          var dD = parseSheetTimestamp(demoValsDbg[di][0]);
          dbgDemoRows.push({
            row: di + 2,
            rawTimestamp: demoValsDbg[di][0],
            parsedDate: dD ? dD.toISOString() : "INVALID/UNPARSEABLE",
            email: emailD,
            matchedRsm: rsmByEmailDbg[emailD.toLowerCase()] || "UNMAPPED EMAIL"
          });
        }

        /* AR:AT sample (Unique Added) — AR=44, 3 cols */
        var uniqValsDbg = repDbg.getRange(2, 44, Math.min(lastRowDbg - 1, 200), 3).getValues();
        for (var ui = 0; ui < uniqValsDbg.length && dbgUniqRows.length < 15; ui++) {
          var emailU = String(uniqValsDbg[ui][2] || "").trim();
          var hospU  = String(uniqValsDbg[ui][1] || "").trim();
          if (!emailU || !hospU) continue;
          var dU = parseSheetTimestamp(uniqValsDbg[ui][0]);
          dbgUniqRows.push({
            row: ui + 2,
            rawDateOfVisit: uniqValsDbg[ui][0],
            parsedDate: dU ? dU.toISOString() : "INVALID/UNPARSEABLE",
            hospital: hospU,
            email: emailU,
            matchedRsm: rsmByEmailDbg[emailU.toLowerCase()] || "UNMAPPED EMAIL"
          });
        }
      }
    }

    var demoComputed = computeDemoActivityRaw();
    var uniqComputed = computeUniqueAddedRaw();

    var dbgDemoOut = JSON.stringify({
      RSM_NAMES: RSM_NAMES,
      demoSampleRows_PR: dbgDemoRows,
      uniqueSampleRows_ARAT: dbgUniqRows,
      computedDemoPerRsm: { week: demoComputed.weekByRsm, month: demoComputed.monthByRsm },
      computedUniquePerRsm: { week: uniqComputed.rsmWeekCounts, month: uniqComputed.rsmMonthCounts }
    });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgDemoOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgDemoOut).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit
     [url]?section=debugRsmRows&rsm=Daya
     to see EVERY single P:R row (Demo) and AR:AT row (Unique
     Added) attributed to that ONE RSM — not just a 15-row sample
     — with its parsed date and which bucket (thisWeek/thisMonth/
     neither) it landed in. This is the row-by-row list to compare
     directly against the sheet's own count for that RSM. ── */
  if (section === "debugRsmRows") {
    var targetRsm = e.parameter.rsm || "";
    var repRsmDbg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var demoRowsForRsm = [], uniqRowsForRsm = [];
    if (repRsmDbg && targetRsm) {
      var lastRowRsmDbg = repRsmDbg.getLastRow();
      if (lastRowRsmDbg >= 2) {
        var rsmByEmailRsmDbg = buildEmailToRsmLookup();

        var today2 = new Date();
        var curMonth2 = today2.getMonth(), curYear2 = today2.getFullYear();
        var currentWeek2 = getCurrentWeekMonToSat();
        var lastMonday2 = currentWeek2.start;
        var lastSunday2 = currentWeek2.end; /* current week Mon-Sat end-of-day */

        /* Every P:R row for this RSM */
        var demoValsRsmDbg = repRsmDbg.getRange(2, 16, lastRowRsmDbg - 1, 3).getValues();
        demoValsRsmDbg.forEach(function(row, idx) {
          var emailD2 = String(row[2] || "").trim().toLowerCase();
          if (!emailD2 || rsmByEmailRsmDbg[emailD2] !== targetRsm) return;
          var dD2 = parseSheetTimestamp(row[0]);
          demoRowsForRsm.push({
            row: idx + 2,
            email: row[2],
            rawTimestamp: row[0],
            parsedDate: dD2 ? dD2.toISOString() : "INVALID/UNPARSEABLE",
            inThisMonth: dD2 ? (dD2.getMonth() === curMonth2 && dD2.getFullYear() === curYear2) : false,
            inCurrentWeek: dD2 ? (dD2 >= lastMonday2 && dD2 <= lastSunday2) : false
          });
        });

        /* Every AR:AT row for this RSM */
        var uniqValsRsmDbg = repRsmDbg.getRange(2, 44, lastRowRsmDbg - 1, 3).getValues();
        uniqValsRsmDbg.forEach(function(row, idx) {
          var emailU2 = String(row[2] || "").trim().toLowerCase();
          var hospU2  = String(row[1] || "").trim();
          if (!emailU2 || !hospU2 || rsmByEmailRsmDbg[emailU2] !== targetRsm) return;
          var dU2 = parseSheetTimestamp(row[0]);
          uniqRowsForRsm.push({
            row: idx + 2,
            hospital: row[1],
            email: row[2],
            rawDateOfVisit: row[0],
            parsedDate: dU2 ? dU2.toISOString() : "INVALID/UNPARSEABLE",
            inThisMonth: dU2 ? (dU2.getMonth() === curMonth2 && dU2.getFullYear() === curYear2) : false,
            inCurrentWeek: dU2 ? (dU2 >= lastMonday2 && dU2 <= lastSunday2) : false
          });
        });
      }
    }
    var dbgRsmOut = JSON.stringify({
      rsm: targetRsm,
      demoRowCount: demoRowsForRsm.length,
      demoRows: demoRowsForRsm,
      uniqueRowCount: uniqRowsForRsm.length,
      uniqueRows: uniqRowsForRsm
    });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgRsmOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgRsmOut).setMimeType(ContentService.MimeType.JSON);
  }

  if (section === "debugKpiValues") {
    var dbgBank = getCurrentBankData();
    var dbgMonthly = getMonthlyPayments();
    var dbgMonthlyTotal = (dbgMonthly.rows || []).reduce(function(s, r) { return s + (Number(r.amount) || 0); }, 0);
    var dbgOverdue6 = getOverdue6PlusMonths();
    var dbgOverdue6Total = (dbgOverdue6.rows || []).reduce(function(s, r) { return s + (Number(r.amount) || 0); }, 0);
    var dbgKpiOut = JSON.stringify({
      currentBank          : dbgBank,
      monthlyPaymentsRows  : dbgMonthly.rows ? dbgMonthly.rows.length : 0,
      expectedPaymentThisMonthTotal : Math.round(dbgMonthlyTotal),
      overdue6PlusRows     : dbgOverdue6.rows ? dbgOverdue6.rows.length : 0,
      overdueSixPlusTotal  : Math.round(dbgOverdue6Total)
    });
    if (cb) return ContentService.createTextOutput(cb + "(" + dbgKpiOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(dbgKpiOut).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Prospective Customers list (Report!BJ:BP) — used by the
     frontend's JSONP fallback path. ── */
  if (section === "prospectiveCustomersList") {
    var pcData = getProspectiveCustomersList();
    if (cb) return ContentService.createTextOutput(cb + "(" + JSON.stringify(pcData) + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(JSON.stringify(pcData)).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Direct test: visit [url]?section=debugCashflow to see EVERY raw
     Report!EC:EG row that falls in the current month, plus the
     normalized group key each one lands under — use this to verify
     a category's total by hand if it ever looks wrong again. ── */
  if (section === "debugCashflow") {
    var repCF = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REPORT_TAB);
    var cfRows = [];
    if (repCF) {
      var lastRowCF = repCF.getLastRow();
      if (lastRowCF >= 2) {
        var nowCF = new Date();
        var curMonthCF = nowCF.getMonth();
        var curYearCF  = nowCF.getFullYear();
        var dataCF = repCF.getRange(2, 133, lastRowCF - 1, 5).getValues();
        dataCF.forEach(function(r, idx) {
          var dateRaw = r[0];
          var partyGroupRaw = String(r[1] || "").replace(/\u00A0/g, " ").trim();
          var d = parseSheetTimestamp(dateRaw);
          var inCurrentMonth = d ? (d.getMonth() === curMonthCF && d.getFullYear() === curYearCF) : false;
          if (!partyGroupRaw && !dateRaw) return; /* skip blank rows entirely, not even logged */
          cfRows.push({
            row          : idx + 2,
            EC_raw       : dateRaw instanceof Date ? dateRaw.toISOString() : String(dateRaw),
            parsedDate   : d ? d.toISOString() : null,
            inCurrentMonth: inCurrentMonth,
            ED_partyGroup: partyGroupRaw,
            groupKey     : partyGroupRaw.toLowerCase(),
            EF_debit     : r[3],
            EG_credit    : r[4]
          });
        });
      }
    }
    var cfOut = JSON.stringify({ rows: cfRows, totalRows: cfRows.length });
    if (cb) return ContentService.createTextOutput(cb + "(" + cfOut + ");").setMimeType(ContentService.MimeType.JAVASCRIPT);
    return ContentService.createTextOutput(cfOut).setMimeType(ContentService.MimeType.JSON);
  }

  if (cb) {
    var payload;
    if (execEmail) {
      payload = getExecutiveDashboardData(execEmail);
    } else {
      var force = e.parameter.forceRefresh === "1";
      payload = getDashboardData(force);
    }
    return ContentService
      .createTextOutput(cb + "(" + JSON.stringify(payload) + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return HtmlService
    .createHtmlOutputFromFile("Index")
    .setTitle("Global Medicare — RSM Dashboard")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ══════════════════════════════════════════════════
   loadAccountsPage()
   Serves the standalone Accounts.html page. Reached via
   doGet(e) when e.parameter.page === "accounts" (i.e. the
   "Accounts" button opens DEPLOYED_URL + "?page=accounts" in
   a new browser tab — a real separate page, not a modal).
══════════════════════════════════════════════════ */
function loadAccountsPage() {
  return HtmlService
    .createHtmlOutputFromFile("Accounts")
    .setTitle("Accounts")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ══════════════════════════════════════════════════
   getCurrentBankData()
   Called from the frontend's "Accounts" button (same-page
   toggle, no navigation) via google.script.run, or via the
   ?section=currentBank JSONP fallback in doGet(e).

   Source: Report!DI:DJ
     DI (col 113) = Label  (e.g. "Current Bank")
     DJ (col 114) = Amount (number)

   Scans the first few rows of DI:DJ for the first row with a
   non-blank label (so it works whether the value sits on row 1
   or a later row), and returns { name, amount }.
══════════════════════════════════════════════════ */
function getCurrentBankData() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { name: "Current Bank", amount: 0 };

  var lastRow = Math.min(rep.getLastRow() || 1, 20);
  var rows = rep.getRange(1, 113, lastRow, 2).getValues(); /* DI=113, DJ=114 */

  var name = "Current Bank";
  var amount = 0;

  for (var i = 0; i < rows.length; i++) {
    var label = String(rows[i][0] || "").trim();
    if (!label) continue;
    var raw = rows[i][1];
    amount = typeof raw === "number" ? raw : (parseFloat(String(raw || "0").replace(/[^0-9.-]/g, "")) || 0);
    name = label;
    break;
  }

  return { name: name, amount: amount };
}

/* ══════════════════════════════════════════════════
   getWeeklyPayments()
   Called from the Accounts section (below the Current Bank
   card) via google.script.run, or via the
   ?section=weeklyPayments JSONP fallback in doGet(e).

   Source: Report!DP:DW (8 cols, DP = col 120)
     DP (col 120) = Bill Date
     DQ (col 121) = Customer Name
     DR (col 122) = State
     DS (col 123) = Amount (w/o GST)
     DT (col 124) = Model
     DU (col 125) = QTY
     DV (col 126) = VARSHA / KAMALJEET
     DW (col 127) = Expected Payment Date  ← filter column

   Logic: only rows whose DW date falls within the CURRENT WEEK,
   defined as Monday 00:00:00 through Sunday 23:59:59 (local
   spreadsheet timezone). Uses the same parseSheetTimestamp()
   used elsewhere in this file, so it correctly handles both
   real Date cells and DD/MM/YYYY text values.
══════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════
   getPaymentSummaryByEmployee()
   Powers the "Payment Summary" panel shown ABOVE "Expected
   Payment Receive This Week" in the Accounts section —
   Kamaljeet / Varsha payment totals across 4 live date windows.

   THIS WEEK / LAST WEEK / THIS MONTH source: Report!FX:GD
   (7-col block, FX = col 180)
     FX (col 180) = (unused here)
     FY (col 181) = (unused here)
     FZ (col 182) = (unused here)
     GA (col 183) = (unused here)
     GB (col 184) = PAYMENT RECEIVED AMOUNT  ← summed
     GC (col 185) = PAYMENT RECEIVED DATE    ← filter column
     GD (col 186) = VARSHA / KAMALJEET       ← employee grouping

   TO BE RECEIVED THIS WEEK source: Report!DP:DW (SEPARATE
   8-col block, DP = col 120) — a different range/logic entirely
   from the 3 windows above:
     DS (col 123) = Amount                    ← summed
     DV (col 126) = VARSHA / KAMALJEET         ← employee grouping
     DW (col 127) = Expected Payment Date      ← filter column

   4 date windows (all computed fresh from the server's current
   date on every call — nothing hardcoded, nothing cached across
   days):
     1. THIS WEEK        : Monday of the current week → TODAY
                            (not the full week — only up to today,
                            per the requirement's own example).
                            Source: FX:GD (GC).
     2. TO BE RECEIVED THIS WEEK : Tomorrow (today + 1 day) →
                            this week's Saturday (inclusive).
                            Source: DP:DW (DW). A DW date that
                            falls on a SUNDAY is treated as if it
                            were the following MONDAY before the
                            range check (Sundays are never "in" a
                            Mon–Sat week in this dashboard's
                            shared definition) — in practice this
                            almost always pushes such a row into
                            NEXT week's window instead, since
                            Monday is always after the current
                            week's Saturday cutoff used here.
     3. LAST WEEK         : the previous FULLY COMPLETED week,
                            Monday → Saturday (7 days before this
                            week's Monday through the day before
                            this week's Monday). Source: FX:GD (GC).
     4. THIS MONTH        : 1st of the current calendar month →
                            TODAY. Source: FX:GD (GC).

   Both GC and DW are parsed via parseSheetTimestamp() (real Date
   objects), never compared as text/string, so this is correct
   regardless of the sheet's date display format.

   Returns:
     {
       employeeOrder: ["Kamaljeet","Varsha"],
       employees: {
         "Kamaljeet": { thisWeek, toBeReceivedThisWeek, lastWeek, thisMonth },
         "Varsha"   : { ... }
       },
       total: { thisWeek, toBeReceivedThisWeek, lastWeek, thisMonth }
     }
══════════════════════════════════════════════════ */
function getPaymentSummaryByEmployee() {
  var EMP_ORDER = ["Kamaljeet", "Varsha"];
  var empty = { employeeOrder: EMP_ORDER, employees: {}, total: { thisWeek: 0, toBeReceivedThisWeek: 0, lastWeek: 0, thisMonth: 0 } };
  EMP_ORDER.forEach(function(e) { empty.employees[e] = { thisWeek: 0, toBeReceivedThisWeek: 0, lastWeek: 0, thisMonth: 0 }; });

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return empty;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return empty;

  var today    = new Date();
  var todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

  /* This week = Monday (shared dashboard-wide current-week
     definition) → TODAY (not the full week). */
  var currentWeek   = getCurrentWeekMonToSat();
  var thisWeekStart = currentWeek.start;

  /* Last week = the previous FULLY COMPLETED Mon→Sat week. */
  var lastWeekStart = new Date(thisWeekStart.getFullYear(), thisWeekStart.getMonth(), thisWeekStart.getDate() - 7);
  lastWeekStart.setHours(0, 0, 0, 0);
  var lastWeekEnd = new Date(lastWeekStart.getFullYear(), lastWeekStart.getMonth(), lastWeekStart.getDate() + 5, 23, 59, 59, 999);

  /* This month = 1st of current month → TODAY. */
  var monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);

  /* FX=180, 7 cols through GD=186 */
  var data = rep.getRange(2, 180, lastRow - 1, 7).getValues();

  var sums = {};
  EMP_ORDER.forEach(function(e) { sums[e] = { thisWeek: 0, lastWeek: 0, thisMonth: 0 }; });

  data.forEach(function(r) {
    var amountRaw = r[4]; /* GB */
    var dateRaw   = r[5]; /* GC */
    var empRaw    = String(r[6] || "").trim(); /* GD */

    if (!empRaw) return;
    var emp = EMP_ORDER.filter(function(e) { return e.toLowerCase() === empRaw.toLowerCase(); })[0];
    if (!emp) return; /* name in sheet doesn't match Kamaljeet/Varsha — skip */

    var d = parseSheetTimestamp(dateRaw); /* real Date object, never text-compared */
    if (!d) return;

    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    if (amount === 0) return;

    if (d >= thisWeekStart && d <= todayEnd)      sums[emp].thisWeek  += amount;
    if (d >= lastWeekStart && d <= lastWeekEnd)   sums[emp].lastWeek  += amount;
    if (d >= monthStart && d <= todayEnd)         sums[emp].thisMonth += amount;
  });

  /* ── "Payment To Be Received This Week" — SEPARATE data source
     (Report!DP:DW, NOT FX:GD) and SEPARATE window:
       Tomorrow (today + 1 day) → this week's Saturday (inclusive)
     If today itself is Saturday, tomorrow is Sunday, which is
     after this week's Saturday — the window is empty and every
     employee's total is correctly ₹0 for the rest of that day.

     DV (col 126, index 6 in this 8-col read) = Varsha/Kamaljeet
     DW (col 127, index 7)                    = Expected Payment Date
     DS (col 123, index 3)                    = Amount

     Sunday handling: if a row's DW falls on a Sunday, it's treated
     as if it were scheduled for the FOLLOWING Monday (Sundays are
     never "in" any Mon–Sat week in this dashboard's shared
     definition) — implemented by shifting the effective date
     forward one day before the range check. */
  var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 0, 0, 0, 0);
  var thisSaturdayEnd = currentWeek.end; /* Saturday 23:59:59.999 */

  var toBeReceivedSums = {};
  EMP_ORDER.forEach(function(e) { toBeReceivedSums[e] = 0; });

  if (tomorrow <= thisSaturdayEnd) {
    /* DP=120, 8 cols through DW=127 — same block getWeeklyPayments()/
       getMonthlyPayments() read, scanned again here independently
       since this panel's window logic is unique to it. */
    var dpData = rep.getRange(2, 120, lastRow - 1, 8).getValues();

    dpData.forEach(function(r) {
      var amountRaw = r[3]; /* DS */
      var empRaw    = String(r[6] || "").trim(); /* DV */
      var dwRaw     = r[7]; /* DW */

      if (!empRaw) return;
      var emp = EMP_ORDER.filter(function(e) { return e.toLowerCase() === empRaw.toLowerCase(); })[0];
      if (!emp) return; /* name doesn't match Kamaljeet/Varsha — skip */

      var dw = parseSheetTimestamp(dwRaw);
      if (!dw) return;

      /* Sunday → shift to the following Monday before comparing */
      var effectiveDate = dw;
      if (dw.getDay() === 0) {
        effectiveDate = new Date(dw.getFullYear(), dw.getMonth(), dw.getDate() + 1, 0, 0, 0, 0);
      } else {
        effectiveDate = new Date(dw.getFullYear(), dw.getMonth(), dw.getDate(), 0, 0, 0, 0);
      }

      if (effectiveDate < tomorrow || effectiveDate > thisSaturdayEnd) return; /* outside tomorrow→Saturday window */

      var amount = typeof amountRaw === "number" ? amountRaw
                   : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
      if (amount === 0) return;

      toBeReceivedSums[emp] += amount;
    });
  }

  var employees = {};
  var total = { thisWeek: 0, toBeReceivedThisWeek: 0, lastWeek: 0, thisMonth: 0 };
  EMP_ORDER.forEach(function(e) {
    var thisWeek             = Math.round(sums[e].thisWeek);
    var toBeReceivedThisWeek = Math.round(toBeReceivedSums[e]);
    var lastWeek             = Math.round(sums[e].lastWeek);
    var thisMonth             = Math.round(sums[e].thisMonth);
    employees[e] = {
      thisWeek             : thisWeek,
      toBeReceivedThisWeek : toBeReceivedThisWeek,
      lastWeek             : lastWeek,
      thisMonth            : thisMonth
    };
    total.thisWeek             += thisWeek;
    total.toBeReceivedThisWeek += toBeReceivedThisWeek;
    total.lastWeek             += lastWeek;
    total.thisMonth            += thisMonth;
  });

  return { employeeOrder: EMP_ORDER, employees: employees, total: total };
}

function getWeeklyPayments() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { rows: [], weekStart: "", weekEnd: "" };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { rows: [], weekStart: "", weekEnd: "" };

  /* Current week: Monday → Saturday (shared dashboard-wide definition) */
  var currentWeek = getCurrentWeekMonToSat();
  var monday = currentWeek.start;
  var sunday = currentWeek.end; /* despite the name, this is now Saturday end-of-day */

  /* DP=120, 8 cols through DW=127 */
  var data = rep.getRange(2, 120, lastRow - 1, 8).getValues();
  var rows = [];

  data.forEach(function(r) {
    var billDateRaw = r[0];
    var customer    = String(r[1] || "").trim();
    var state       = String(r[2] || "").trim();
    var amountRaw   = r[3];
    var model       = String(r[4] || "").trim();
    var qtyRaw      = r[5];
    var person      = String(r[6] || "").trim();
    var expDateRaw  = r[7];

    if (!customer && !expDateRaw) return; /* skip blank rows */

    var expDate = parseSheetTimestamp(expDateRaw);
    if (!expDate) return;                          /* no expected date → not this week */
    if (expDate < monday || expDate > sunday) return; /* outside current week → skip */

    var billDate = parseSheetTimestamp(billDateRaw);
    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    rows.push({
      billDate     : billDate ? billDate.toISOString() : "",
      customer     : customer,
      state        : state,
      amount       : amount,
      model        : model,
      qty          : qty,
      person       : person,
      expectedDate : expDate.toISOString()
    });
  });

  rows.sort(function(a, b) { return new Date(a.expectedDate) - new Date(b.expectedDate); });

  return {
    rows      : rows,
    weekStart : monday.toISOString(),
    weekEnd   : sunday.toISOString()
  };
}

/* ══════════════════════════════════════════════════
   getTotalAmountReceivedThisMonth()
   Powers the "TOTAL AMOUNT RECEIVE THIS MONTH" panel — shown
   ABOVE "Expected Payment Receive This Month" in the Accounts
   section. Called via google.script.run, or via the
   ?section=totalAmountReceivedThisMonth JSONP fallback in
   doGet(e).

   Source: Report!FX:GD (7-col block, FX = col 180) — the SAME
   range the Payment Summary panel reads (its logic is untouched
   by this function; this is an independent read of the same
   columns):
     FX (col 180) = Bill Date
     FY (col 181) = Customer
     FZ (col 182) = State
     GA (col 183) = Model
     GB (col 184) = Payment Received Amount  ← summed
     GC (col 185) = Payment Received Date    ← filter column
     GD (col 186) = Varsha / Kamaljeet

   Logic: only rows whose GC falls in the CURRENT CALENDAR MONTH
   (1st of this month → today) — computed from the server's
   current date every call, so it always shows "1st → today" for
   whatever the current month is, with no manual update ever
   needed (e.g. 12 Aug → 01–12 Aug; 13 Aug → 01–13 Aug; rolls to
   September's 1st automatically once the month changes).

   Returns each row in the requested DISPLAY order already:
     { billDate, customer, state, model, amount, receivedDate, person }

   Returns: { rows: [...], total, monthStart, monthEnd }
══════════════════════════════════════════════════ */
function getTotalAmountReceivedThisMonth() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { rows: [], total: 0, monthStart: "", monthEnd: "" };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { rows: [], total: 0, monthStart: "", monthEnd: "" };

  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();
  var monthStart = new Date(curYear, curMonth, 1, 0, 0, 0, 0);
  var todayEnd    = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  /* FX=180, 7 cols through GD=186 */
  var data = rep.getRange(2, 180, lastRow - 1, 7).getValues();
  var rows = [];
  var total = 0;

  data.forEach(function(r) {
    var billDateRaw = r[0]; /* FX */
    var customer     = String(r[1] || "").trim(); /* FY */
    var state        = String(r[2] || "").trim(); /* FZ */
    var model         = String(r[3] || "").trim(); /* GA */
    var amountRaw     = r[4]; /* GB */
    var receivedRaw   = r[5]; /* GC */
    var person         = String(r[6] || "").trim(); /* GD */

    if (!customer && !receivedRaw) return; /* skip blank rows */

    var receivedDate = parseSheetTimestamp(receivedRaw);
    if (!receivedDate) return; /* no/invalid Payment Received Date → can't classify, skip */
    if (receivedDate < monthStart || receivedDate > todayEnd) return; /* outside 1st-of-month → today, skip */

    var billDate = parseSheetTimestamp(billDateRaw);
    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    total += amount;
    rows.push({
      billDate     : billDate ? billDate.toISOString() : "",
      customer     : customer,
      state        : state,
      model        : model,
      amount       : Math.round(amount),
      receivedDate : receivedDate.toISOString(),
      person       : person
    });
  });

  /* Latest received date first */
  rows.sort(function(a, b) { return new Date(b.receivedDate) - new Date(a.receivedDate); });

  return {
    rows       : rows,
    total      : Math.round(total),
    monthStart : monthStart.toISOString(),
    monthEnd   : todayEnd.toISOString()
  };
}

/* ══════════════════════════════════════════════════
   getAccountsReceivable()
   Powers the "ACCOUNTS RECEIVABLE" panel — shown immediately
   BELOW "Total Amount Receive This Month" in the Accounts
   section. Called via google.script.run, or via the
   ?section=accountsReceivable JSONP fallback in doGet(e).

   Source: Report!GF:GK (6-col block, GF = col 188) — CONFIRMED
   column mapping:
     GF (col 188) = Bill Date
     GG (col 189) = Customer
     GH (col 190) = State
     GI (col 191) = Model
     GJ (col 192) = Balance          ← the value shown
     GK (col 193) = Varsha / Kamaljeet

   Logic: no date filter — every row with a non-blank Customer
   (GG) is included, live from the sheet every call. Rows with a
   zero/blank Balance are still included (so nothing silently
   disappears) — only rows with literally no Customer name are
   skipped.

   Returns: { rows: [ { billDate, customer, state, model, balance, person }, ... ], total }
══════════════════════════════════════════════════ */
function getAccountsReceivable() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { rows: [], total: 0 };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { rows: [], total: 0 };

  /* GF=188, 6 cols through GK=193 */
  var data = rep.getRange(2, 188, lastRow - 1, 6).getValues();
  var rows = [];
  var total = 0;

  data.forEach(function(r) {
    var billDateRaw = r[0]; /* GF */
    var customer     = String(r[1] || "").trim(); /* GG */
    var state        = String(r[2] || "").trim(); /* GH */
    var model         = String(r[3] || "").trim(); /* GI */
    var balanceRaw     = r[4]; /* GJ */
    var person          = String(r[5] || "").trim(); /* GK */

    if (!customer) return; /* skip fully blank rows */

    var billDate = parseSheetTimestamp(billDateRaw);
    var balance = typeof balanceRaw === "number" ? balanceRaw
                  : (parseFloat(String(balanceRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    total += balance;
    rows.push({
      billDate : billDate ? billDate.toISOString() : "",
      customer : customer,
      state    : state,
      model    : model,
      balance  : Math.round(balance),
      person   : person
    });
  });

  return { rows: rows, total: Math.round(total) };
}

/* ══════════════════════════════════════════════════
   getMonthlyPayments()
   Called from the Accounts section (below the Weekly Payments
   panel) via google.script.run, or via the
   ?section=monthlyPayments JSONP fallback in doGet(e).

   Source: Report!DP:DW (same 8-col block as getWeeklyPayments(),
   DP = col 120). Column meanings are identical — see
   getWeeklyPayments() above.

   Logic: only rows whose DW (Expected Payment Date) falls in
   the CURRENT CALENDAR MONTH — i.e.
     expectedDate.getMonth() === now.getMonth()
     AND expectedDate.getFullYear() === now.getFullYear()
   This is naturally "automatic" — since it's computed from
   the server's current date every time the function runs,
   no manual month update is ever needed.
══════════════════════════════════════════════════ */
function getMonthlyPayments() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { rows: [], monthStart: "", monthEnd: "" };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { rows: [], monthStart: "", monthEnd: "" };

  var now = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();
  var monthStart = new Date(curYear, curMonth, 1, 0, 0, 0, 0);
  var monthEnd   = new Date(curYear, curMonth + 1, 0, 23, 59, 59, 999); /* last day of month */

  /* DP=120, 8 cols through DW=127 */
  var data = rep.getRange(2, 120, lastRow - 1, 8).getValues();
  var rows = [];

  data.forEach(function(r) {
    var billDateRaw = r[0];
    var customer    = String(r[1] || "").trim();
    var state       = String(r[2] || "").trim();
    var amountRaw   = r[3];
    var model       = String(r[4] || "").trim();
    var qtyRaw      = r[5];
    var person      = String(r[6] || "").trim();
    var expDateRaw  = r[7];

    if (!customer && !expDateRaw) return; /* skip blank rows */

    var expDate = parseSheetTimestamp(expDateRaw);
    if (!expDate) return;
    if (expDate.getMonth() !== curMonth || expDate.getFullYear() !== curYear) return;

    var billDate = parseSheetTimestamp(billDateRaw);
    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    rows.push({
      billDate     : billDate ? billDate.toISOString() : "",
      customer     : customer,
      state        : state,
      amount       : amount,
      model        : model,
      qty          : qty,
      person       : person,
      expectedDate : expDate.toISOString()
    });
  });

  /* ══════════════════════════════════════════════
     Merge duplicate rows: same Customer + same Model → one row.
     QTY and Amount are summed; Bill Date keeps the LATEST of the
     merged rows; State/Owner (Varsha/Kamaljeet) keep the first
     seen value. Applied ONLY here (monthly) — the weekly report
     (getWeeklyPayments) is intentionally left showing individual
     rows and is not touched.
  ══════════════════════════════════════════════ */
  var grouped = {};
  var groupOrder = []; /* preserves first-seen order for stable output */

  rows.forEach(function(row) {
    var key = row.customer + "_" + row.model;
    if (!grouped[key]) {
      grouped[key] = {
        billDate     : row.billDate,
        customer     : row.customer,
        state        : row.state,
        amount       : row.amount,
        model        : row.model,
        qty          : row.qty,
        person       : row.person,
        expectedDate : row.expectedDate
      };
      groupOrder.push(key);
    } else {
      var g = grouped[key];
      g.qty    += row.qty;
      g.amount += row.amount;
      /* Keep the LATEST bill date among merged rows */
      if (row.billDate && (!g.billDate || new Date(row.billDate) > new Date(g.billDate))) {
        g.billDate = row.billDate;
      }
      /* Keep the earliest expected date among merged rows, for sorting */
      if (row.expectedDate && (!g.expectedDate || new Date(row.expectedDate) < new Date(g.expectedDate))) {
        g.expectedDate = row.expectedDate;
      }
    }
  });

  var mergedRows = groupOrder.map(function(key) { return grouped[key]; });
  /* Sorted by Amount, highest first — amount is already a parsed
     numeric field (₹/commas stripped when the row was built above),
     so no extra text-cleanup is needed here. */
  mergedRows.sort(function(a, b) { return b.amount - a.amount; });

  return {
    rows       : mergedRows,
    monthStart : monthStart.toISOString(),
    monthEnd   : monthEnd.toISOString()
  };
}

/* ══════════════════════════════════════════════════
   getOverdueInvoices()
   Called from the Accounts section (below the Monthly Payments
   panel) via google.script.run, or via the
   ?section=overdueInvoices JSONP fallback in doGet(e).

   Source: Report!DP:DW (same 8-col block as getWeeklyPayments()/
   getMonthlyPayments(), DP = col 120). Column meanings identical.

   Logic: "Overdue Invoices (3–6 Months)" = rows whose DW
   (Expected Payment Date) falls between 6 months ago and 3
   months ago from today — i.e. payment was expected 3 to 6
   months back and is presumably still outstanding. Computed
   from the server's current date every call, so the window
   shifts forward automatically with no manual update needed.

   Same Customer + Model merge as getMonthlyPayments() is applied
   here too (QTY/Amount summed, latest Bill Date kept), for
   consistency with the Monthly section's column layout.
══════════════════════════════════════════════════ */
function getOverdueInvoices() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { rows: [], rangeStart: "", rangeEnd: "" };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { rows: [], rangeStart: "", rangeEnd: "" };

  var now = new Date();
  /* Window: 6 months ago (start) → 3 months ago (end), based on BILL DATE (DP) */
  var rangeStart = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate(), 0, 0, 0, 0);
  var rangeEnd   = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate(), 23, 59, 59, 999);

  /* DP=120, 8 cols through DW=127 */
  var data = rep.getRange(2, 120, lastRow - 1, 8).getValues();
  var rows = [];

  data.forEach(function(r) {
    var billDateRaw = r[0];
    var customer    = String(r[1] || "").trim();
    var state       = String(r[2] || "").trim();
    var amountRaw   = r[3];
    var model       = String(r[4] || "").trim();
    var qtyRaw      = r[5];
    var person      = String(r[6] || "").trim();
    var expDateRaw  = r[7];

    if (!customer && !billDateRaw) return; /* skip blank rows */

    var billDate = parseSheetTimestamp(billDateRaw);
    if (!billDate) return;                                     /* no bill date → can't classify, skip */
    if (billDate < rangeStart || billDate > rangeEnd) return;  /* outside 3–6 month window → skip */

    var expDate = parseSheetTimestamp(expDateRaw);
    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    rows.push({
      billDate     : billDate.toISOString(),
      customer     : customer,
      state        : state,
      amount       : amount,
      model        : model,
      qty          : qty,
      person       : person,
      expectedDate : expDate ? expDate.toISOString() : ""
    });
  });

  /* Same Customer + Model merge as the Monthly report */
  var grouped = {};
  var groupOrder = [];

  rows.forEach(function(row) {
    var key = row.customer + "_" + row.model;
    if (!grouped[key]) {
      grouped[key] = {
        billDate     : row.billDate,
        customer     : row.customer,
        state        : row.state,
        amount       : row.amount,
        model        : row.model,
        qty          : row.qty,
        person       : row.person,
        expectedDate : row.expectedDate
      };
      groupOrder.push(key);
    } else {
      var g = grouped[key];
      g.qty    += row.qty;
      g.amount += row.amount;
      /* Keep the EARLIEST bill date among merged rows — that's the
         oldest outstanding invoice for this customer+model, which is
         the more useful (more overdue) date to surface. */
      if (row.billDate && (!g.billDate || new Date(row.billDate) < new Date(g.billDate))) {
        g.billDate = row.billDate;
      }
    }
  });

  var mergedRows = groupOrder.map(function(key) { return grouped[key]; });
  /* Oldest bill first — the most overdue ones surface at the top */
  mergedRows.sort(function(a, b) { return new Date(a.billDate) - new Date(b.billDate); });

  return {
    rows       : mergedRows,
    rangeStart : rangeStart.toISOString(),
    rangeEnd   : rangeEnd.toISOString()
  };
}

/* ══════════════════════════════════════════════════
   getOverdue6PlusMonths()
   Called from the Accounts section (below the "Overdue Invoices
   (3–6 Months)" panel) via google.script.run, or via the
   ?section=overdue6Plus JSONP fallback in doGet(e).

   Source: Report!DP:DW (same 8-col block as the other Accounts
   reports, DP = col 120). Column meanings identical.

   Logic: "Overdue Invoices (Over 6 Months)" = rows whose DP
   (Bill Date) is OLDER than 6 months ago from today — i.e.
     billDate < (today - 6 months)
   No upper bound (unlike the 3–6 month report), so anything
   older just keeps accumulating here until it's paid/removed.
   Computed from the server's current date every call, so the
   6-month cutoff shifts forward automatically every month with
   no manual update needed.

   Same Customer + Model merge as the other Accounts reports is
   applied (QTY/Amount summed, earliest Bill Date kept — the
   oldest outstanding one is the more useful date to surface).
══════════════════════════════════════════════════ */
function getOverdue6PlusMonths() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { rows: [], cutoffDate: "" };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { rows: [], cutoffDate: "" };

  var now = new Date();
  /* Cutoff: 6 months ago from today. Anything billed BEFORE this is overdue 6+ months. */
  var cutoffDate = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate(), 0, 0, 0, 0);

  /* DP=120, 8 cols through DW=127 */
  var data = rep.getRange(2, 120, lastRow - 1, 8).getValues();
  var rows = [];

  data.forEach(function(r) {
    var billDateRaw = r[0];
    var customer    = String(r[1] || "").trim();
    var state       = String(r[2] || "").trim();
    var amountRaw   = r[3];
    var model       = String(r[4] || "").trim();
    var qtyRaw      = r[5];
    var person      = String(r[6] || "").trim();
    var expDateRaw  = r[7];

    if (!customer && !billDateRaw) return; /* skip blank rows */

    var billDate = parseSheetTimestamp(billDateRaw);
    if (!billDate) return;              /* no bill date → can't classify, skip */
    if (billDate >= cutoffDate) return; /* not yet 6 months overdue → skip (belongs in the 3–6 month report or newer) */

    var expDate = parseSheetTimestamp(expDateRaw);
    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    rows.push({
      billDate     : billDate.toISOString(),
      customer     : customer,
      state        : state,
      amount       : amount,
      model        : model,
      qty          : qty,
      person       : person,
      expectedDate : expDate ? expDate.toISOString() : ""
    });
  });

  /* Same Customer + Model merge as the other Accounts reports */
  var grouped = {};
  var groupOrder = [];

  rows.forEach(function(row) {
    var key = row.customer + "_" + row.model;
    if (!grouped[key]) {
      grouped[key] = {
        billDate     : row.billDate,
        customer     : row.customer,
        state        : row.state,
        amount       : row.amount,
        model        : row.model,
        qty          : row.qty,
        person       : row.person,
        expectedDate : row.expectedDate
      };
      groupOrder.push(key);
    } else {
      var g = grouped[key];
      g.qty    += row.qty;
      g.amount += row.amount;
      /* Keep the EARLIEST bill date — the oldest outstanding invoice
         for this customer+model, which is the more useful (more
         overdue) date to surface. */
      if (row.billDate && (!g.billDate || new Date(row.billDate) < new Date(g.billDate))) {
        g.billDate = row.billDate;
      }
    }
  });

  var mergedRows = groupOrder.map(function(key) { return grouped[key]; });
  /* Oldest bill first — the most overdue ones surface at the top */
  mergedRows.sort(function(a, b) { return new Date(a.billDate) - new Date(b.billDate); });

  return {
    rows       : mergedRows,
    cutoffDate : cutoffDate.toISOString()
  };
}

/* ══════════════════════════════════════════════════
   getOverBudgetExpenses()
   Called from the Accounts section (below "Overdue Invoices
   (Over 6 Months)") via google.script.run, or via the
   ?section=overBudget JSONP fallback in doGet(e).

   Source: Report!DL:DN (3 cols, DL = col 116)
     DL (col 116) = Expense Category
     DM (col 117) = Yearly Budget (April → March fiscal year)
     DN (col 118) = Amount Paid (so far, this fiscal year)

   Logic:
   - Budget is for the FULL fiscal year (Apr–Mar), so:
       monthlyBudget = yearlyBudget / 12
   - Fiscal-year month index (April = 1, ... March = 12):
       currentMonth (1-indexed, Jan=1..Dec=12)
       monthIndex = currentMonth >= 4 ? (currentMonth - 3) : (currentMonth + 9)
     e.g. July (currentMonth=7) → monthIndex = 4
   - Expected spend to date:
       expectedSpend = monthlyBudget * monthIndex

   Returns EVERY category (not just over-budget ones) as:
     [ { category, expected, actual, overBudget }, ... ]
   where overBudget = (actual > expected). The frontend shows
   all rows and highlights the over-budget ones in red — the
   function name is kept as-is (getOverBudgetExpenses) even
   though it now returns everything, to avoid touching the
   doGet() route / frontend call sites that already reference it.

   Sort order: over-budget categories first (worst offenders —
   largest overage — at the very top), followed by the rest in
   their original sheet order.
══════════════════════════════════════════════════ */
function getOverBudgetExpenses() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return [];

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return [];

  var now = new Date();
  var currentMonth = now.getMonth() + 1; /* 1-indexed: Jan=1 ... Dec=12 */
  var monthIndex = currentMonth >= 4 ? (currentMonth - 3) : (currentMonth + 9);

  /* DL=116, 3 cols through DN=118 */
  var data = rep.getRange(2, 116, lastRow - 1, 3).getValues();
  var results = [];

  data.forEach(function(r, idx) {
    var category  = String(r[0] || "").trim();
    var yearlyRaw = r[1];
    var paidRaw   = r[2];

    if (!category) return; /* skip blank rows */

    var yearlyBudget = typeof yearlyRaw === "number" ? yearlyRaw
                        : (parseFloat(String(yearlyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var amountPaid = typeof paidRaw === "number" ? paidRaw
                      : (parseFloat(String(paidRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    var monthlyBudget = yearlyBudget / 12;
    var expectedSpend = monthlyBudget * monthIndex;
    var overBudget    = amountPaid > expectedSpend;

    results.push({
      category     : category,
      expected     : Math.round(expectedSpend),
      actual       : Math.round(amountPaid),
      yearlyBudget : Math.round(yearlyBudget), /* DM — used for the "(2.46 Cr)" bracket label AND for sorting the within-budget rows below */
      overBudget   : overBudget
    });
  });

  /* Over-budget first (largest overage first — these stay in the
     red box at the top). Within-budget categories are sorted by
     Yearly Budget (DM) descending — biggest budget first. */
  results.sort(function(a, b) {
    if (a.overBudget !== b.overBudget) return a.overBudget ? -1 : 1;
    if (a.overBudget) return (b.actual - b.expected) - (a.actual - a.expected);
    return b.yearlyBudget - a.yearlyBudget;
  });

  return results;
}

/* ══════════════════════════════════════════════════
   getInventoryItemWise()
   Called from the Accounts section (below "Expenses Going Over
   Budget") via google.script.run, or via the
   ?section=inventoryItemWise JSONP fallback in doGet(e).

   SINGLE data source: Report!DY:EA (3 cols, DY=129)
     DY (col 129) = Model  — this column ALSO carries the company
                             names, interleaved with their items
     DZ (col 130) = Qty
     EA (col 131) = Amount

   The company/item hierarchy is NOT a separate sheet — it's
   encoded directly in this same column via cell background color:
     - A COMPANY HEADER row is a row whose DY cell has a YELLOW
       (non-white/non-default) background highlight
       (e.g. "MEDTRONIC", "KANLIFE", "BEDFONT", "JIANGSU - HEM...").
       Everything from that row until the next highlighted row
       belongs to that company.
     - If a company header row ITSELF has a non-zero Qty or
       Amount (e.g. "ERBE", "JIANGSU - HEMORRHOIDS" carry their
       own qty/amount directly, with no separate item row below
       them), that row's own values are recorded as one item
       named after the company itself — this covers
       single-product companies where the header row IS the only
       item (applies the same way to ERBE, HIKIMAGING, POTENT,
       NIRAMAI THERMALYTICS, ONDAL, or any other company shaped
       like this).
     - Non-highlighted rows below a header are that company's
       items, using their own Qty/Amount.
     - Fully blank rows (no text in DY) are just spacing and are
       skipped without changing which company is "current".
     - Rows where BOTH qty=0 AND amount=0 are left out (hide
       zero/zero rows), same as the other Accounts reports.
     - No name-based guessing anywhere — grouping is 100% driven
       by the highlight + row order, never by keyword matching.

   This reads the live sheet every time, so adding a new company
   or item in Report!DY:EA (as long as company rows stay
   yellow-highlighted) shows up automatically — nothing needs to
   be hardcoded or edited here again.

   Returns:
     {
       companies : [ "MEDTRONIC", "KANLIFE", ... ]   (sheet order)
       data      : { "MEDTRONIC": [ {item,qty,amount}, ... ], ... }
     }
══════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════
   getThisMonthSale()
   Powers the "This Month Sale" KPI card (shown right below
   "Annual Target" on the main dashboard) and its click-to-expand
   Model-wise breakdown.

   Source: Report!EQ:EX (8-col block, EQ = col 147)
     EQ (col 147) = Bill Date     ← filter column (THIS function
                                     filters by Bill Date, unlike
                                     Weekly/Monthly Payments which
                                     filter by Expected Payment
                                     Date)
     ER (col 148) = Customer Name
     ES (col 149) = State
     ET (col 150) = Amount W/O GST ← the value summed
     EU (col 151) = Model          ← grouping key for breakdown
     EV (col 152) = Qty
     EW (col 153) = Varsha / Kamaljeet
     EX (col 154) = Expected Payment Date (not used here)

   Logic:
   - Only rows whose Bill Date (EQ) falls in the CURRENT calendar
     month (computed from the server's date every call, so it
     shifts automatically — no hardcoded month).
   - total = sum of Amount W/O GST (ET) across those rows.
   - byModel = same rows grouped by Model (EU), each with its own
     summed Amount — used for the click-to-expand breakdown.

   Returns:
     {
       total,
       byModel   : [ { model, value }, ... ]   (legacy flat list, kept
                    for backward-compat — NOT color-grouped)
       whiteModels, yellowModels, redModels : [ { model, value }, ... ]
         Same entries as byModel, but split into 3 groups based on
         the EU cell's background color (White / Yellow / Red),
         each group independently sorted descending by amount. The
         color for a model is taken from the FIRST row that model
         appeared in (models are expected to be consistently
         color-coded in the sheet).
   }
   (byModel sorted by value descending — biggest model first)
══════════════════════════════════════════════════ */
function classifyEuBgColor(hex) {
  if (!hex) return "white";
  hex = String(hex).trim().toLowerCase();
  if (hex === "" || hex === "#ffffff" || hex === "#fff") return "white";
  if (hex.charAt(0) !== "#" || hex.length < 7) return "white";
  var r = parseInt(hex.substring(1, 3), 16);
  var g = parseInt(hex.substring(3, 5), 16);
  var b = parseInt(hex.substring(5, 7), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return "white";
  /* Red-ish: red channel clearly dominant over green/blue */
  if (r > 170 && r - g > 40 && r - b > 40) return "red";
  /* Yellow-ish: red AND green both high, blue clearly lower */
  if (r > 170 && g > 150 && (r - b) > 60 && (g - b) > 40) return "yellow";
  return "white";
}

/* ══════════════════════════════════════════════════
   computeEqExSaleBreakdown(dateFilterFn)
   Shared engine behind getThisMonthSale() — reads Report!EQ:EX
   and does the White/Yellow/Red grouping. dateFilterFn decides
   which rows are in scope (currently only "this calendar month"
   is used, via getThisMonthSale()).

   Source: Report!EQ:EX (8-col block, EQ = col 147)
     EQ (col 147) = Bill Date     ← filter column
     ER (col 148) = Customer Name
     ES (col 149) = State
     ET (col 150) = Amount W/O GST ← the value summed
     EU (col 151) = Model          ← grouping key + color source
     EV (col 152) = Qty
     EW (col 153) = Varsha / Kamaljeet
     EX (col 154) = Expected Payment Date (not used here)

   dateFilterFn(billDate) → true/false decides whether a row is
   included (the caller supplies "is this month" or "is this FY").

   Color grouping: each model's EU cell background (from its
   FIRST occurrence) is classified via classifyEuBgColor() into
   white / yellow / red, and results are split into 3 groups —
   White first, then Yellow, then Red — each independently sorted
   descending by amount.

   Returns:
     {
       total,
       byModel     : [ { model, value }, ... ]   (legacy flat list,
                      sorted descending, NOT color-grouped)
       whiteModels, yellowModels, redModels : same entries split
         by color, each sorted descending — this is what the
         click-to-expand tables actually render (White → gap →
         Yellow → gap → Red).
     }
══════════════════════════════════════════════════ */
function computeEqExSaleBreakdown(dateFilterFn) {
  var empty = { total: 0, byModel: [], whiteModels: [], yellowModels: [], redModels: [] };
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return empty;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return empty;

  /* EQ=147, 8 cols through EX=154 */
  var range       = rep.getRange(2, 147, lastRow - 1, 8);
  var data        = range.getValues();
  var backgrounds = range.getBackgrounds(); /* same shape; [i][4] = EU cell's background */
  var total = 0;
  var modelMap   = {}; /* model -> summed Amount */
  var modelQtyMap = {}; /* model -> summed Qty */
  var modelColor = {};

  data.forEach(function(r, idx) {
    var billDateRaw = r[0]; /* EQ */
    var amountRaw    = r[3]; /* ET */
    var model        = String(r[4] || "").trim(); /* EU */
    var qtyRaw        = r[5]; /* EV */

    var billDate = parseSheetTimestamp(billDateRaw);
    if (!billDate) return;
    if (!dateFilterFn(billDate)) return;

    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    if (amount === 0) return;

    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    total += amount;
    if (model) {
      modelMap[model] = (modelMap[model] || 0) + amount;
      modelQtyMap[model] = (modelQtyMap[model] || 0) + qty;
      if (!modelColor[model]) {
        modelColor[model] = classifyEuBgColor(backgrounds[idx][4]);
      }
    }
  });

  var byModel = Object.keys(modelMap)
    .map(function(m) { return { model: m, qty: modelQtyMap[m] || 0, value: Math.round(modelMap[m]) }; })
    .sort(function(a, b) { return b.value - a.value; });

  var whiteModels = [], yellowModels = [], redModels = [];
  Object.keys(modelMap).forEach(function(m) {
    var entry = { model: m, qty: modelQtyMap[m] || 0, value: Math.round(modelMap[m]) };
    var color = modelColor[m] || "white";
    if (color === "yellow") yellowModels.push(entry);
    else if (color === "red") redModels.push(entry);
    else whiteModels.push(entry);
  });
  whiteModels.sort(function(a, b) { return b.value - a.value; });
  yellowModels.sort(function(a, b) { return b.value - a.value; });
  redModels.sort(function(a, b) { return b.value - a.value; });

  return {
    total: Math.round(total),
    byModel: byModel,
    whiteModels: whiteModels,
    yellowModels: yellowModels,
    redModels: redModels
  };
}

/* ══════════════════════════════════════════════════
   getThisMonthSale()
   Powers the "This Month Sale" KPI card and its click-to-expand
   Model-wise breakdown (White → gap → Yellow → gap → Red).
   Date window: the CURRENT calendar month only.
══════════════════════════════════════════════════ */
function getThisMonthSale() {
  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();
  return computeEqExSaleBreakdown(function(billDate) {
    return billDate.getMonth() === curMonth && billDate.getFullYear() === curYear;
  });
}

/* ══════════════════════════════════════════════════
   getTotalSaleYtdRows()
   Powers the "TOTAL SALE YTD" button (placed next to "Remaining"
   in the MJ section) and its click-to-expand detail table.
   Unlike getThisMonthSale() (which aggregates by Model), this
   returns individual RAW rows — one per transaction — since the
   detail table shows Bill Date / Customer / State / Model / Qty /
   Amount per row.

   NOT included in the main getDashboardData() payload as full
   row data — fetched lazily on first click (same lazy-load
   pattern used by the Accounts section), since a full year of
   raw rows could be sizable. Only the lightweight grand TOTAL is
   pre-computed and sent with the main payload so the button can
   show its amount immediately without waiting for a click.

   Source: SAME Report!EQ:EX block as getThisMonthSale() —
     EQ (col 147) = Bill Date     ← filter column
     ER (col 148) = Customer Name
     ES (col 149) = State
     ET (col 150) = Amount W/O GST
     EU (col 151) = Model          ← color source
     EV (col 152) = Qty

   Logic:
   - Only rows within the current Financial Year (1 April → 31
     March next year).
   - EVERY row is included (all 3 colors), each tagged with its
     EU cell's classified color: White = Capex, Yellow =
     Consumables, Red = Others.
   - Split into 3 row-level groups (whiteRows/yellowRows/redRows),
     each independently sorted DESCENDING by Amount — the
     frontend renders White → gap → Yellow → gap → Red.

   Returns:
     {
       total,
       whiteRows, yellowRows, redRows :
         [ { billDate, customer, state, model, qty, amount }, ... ]
     }
══════════════════════════════════════════════════ */
function getTotalSaleYtdRows() {
  var empty = { total: 0, whiteRows: [], yellowRows: [], redRows: [] };
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return empty;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return empty;

  var today   = new Date();
  var fyYear  = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  var fyStart = new Date(fyYear, 3, 1);
  var fyEnd   = new Date(fyYear + 1, 2, 31, 23, 59, 59, 999);

  /* EQ=147, 8 cols through EX=154 */
  var range       = rep.getRange(2, 147, lastRow - 1, 8);
  var data        = range.getValues();
  var backgrounds = range.getBackgrounds();
  var total = 0;
  var whiteRows = [], yellowRows = [], redRows = [];

  data.forEach(function(r, idx) {
    var billDateRaw = r[0]; /* EQ */
    var customer    = String(r[1] || "").trim(); /* ER */
    var state       = String(r[2] || "").trim(); /* ES */
    var amountRaw   = r[3]; /* ET */
    var model       = String(r[4] || "").trim(); /* EU */
    var qtyRaw      = r[5]; /* EV */

    var billDate = parseSheetTimestamp(billDateRaw);
    if (!billDate) return;
    if (billDate < fyStart || billDate > fyEnd) return;

    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    if (amount === 0) return;

    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    total += amount;
    var row = {
      billDate : billDate.toISOString(),
      customer : customer,
      state    : state,
      model    : model,
      qty      : qty,
      amount   : Math.round(amount)
    };

    var color = classifyEuBgColor(backgrounds[idx][4]);
    if (color === "yellow") yellowRows.push(row);
    else if (color === "red") redRows.push(row);
    else whiteRows.push(row);
  });

  whiteRows.sort(function(a, b) { return b.amount - a.amount; });
  yellowRows.sort(function(a, b) { return b.amount - a.amount; });
  redRows.sort(function(a, b) { return b.amount - a.amount; });

  return { total: Math.round(total), whiteRows: whiteRows, yellowRows: yellowRows, redRows: redRows };
}

/* ══════════════════════════════════════════════════
   getSaleTrendProductWise()
   Powers the "Sale Trend (Product Wise)" panel — opens together
   with "Total Sale YTD — Transaction Detail" whenever the
   "Total Sale YTD" card is clicked.

   Source: SAME Report!EQ:EX block as getTotalSaleYtdRows() —
     EQ (col 147) = Bill Date
     ET (col 150) = Amount W/O GST
     EU (col 151) = Model (Product) ← color source (White=Capex,
                                        Yellow=Consumables,
                                        Red=Others)
     EV (col 152) = Qty

   Month columns: built DYNAMICALLY, starting from April of the
   current Financial Year through the CURRENT calendar month —
   never hardcoded, so a new month appears automatically once the
   calendar rolls over (e.g. August is added automatically once
   it becomes August).

   Logic:
   - Every row within that April→current-month window is
     included (no color filter at the row level — every product
     shows up, just bucketed by its own color).
   - Per product, per month: Qty and Amount are summed
     independently.
   - Products are grouped into capexProducts (White) and
     consumableProducts (Yellow), each sorted alphabetically by
     product name. Any product classified "red" (Others) is kept
     in a 3rd otherProducts group rather than silently dropped —
     it simply won't render if the group ends up empty.

   Returns:
     {
       months: [ "Apr", "May", ... ],   // labels, in order
       capexProducts, consumableProducts, otherProducts:
         [ { product, monthly: [ { qty, amount }, ... ] }, ... ]
         (monthly array is index-aligned with `months`)
     }
══════════════════════════════════════════════════ */
function getSaleTrendProductWise() {
  var empty = { months: [], capexProducts: [], consumableProducts: [], otherProducts: [] };
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return empty;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return empty;

  var MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var today   = new Date();
  var fyYear  = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;

  /* Build the month list: April (fyYear) through the current
     month (inclusive) — dynamic, no hardcoded month names. */
  var months = []; /* [{ year, month(0-11), label }] */
  var y = fyYear, m = 3; /* April = index 3 */
  for (var guard = 0; guard < 12; guard++) {
    months.push({ year: y, month: m, label: MONTH_NAMES[m] });
    if (y === today.getFullYear() && m === today.getMonth()) break;
    m++;
    if (m > 11) { m = 0; y++; }
  }

  /* EQ=147, 8 cols through EX=154 */
  var range       = rep.getRange(2, 147, lastRow - 1, 8);
  var data        = range.getValues();
  var backgrounds = range.getBackgrounds();

  var productMap = {}; /* model -> { color, monthly: { "year-month": {qty, amount} } } */

  data.forEach(function(r, idx) {
    var billDateRaw = r[0]; /* EQ */
    var amountRaw    = r[3]; /* ET */
    var model        = String(r[4] || "").trim(); /* EU */
    var qtyRaw        = r[5]; /* EV */
    if (!model) return;

    var billDate = parseSheetTimestamp(billDateRaw);
    if (!billDate) return;

    var inRange = months.some(function(mo) {
      return mo.year === billDate.getFullYear() && mo.month === billDate.getMonth();
    });
    if (!inRange) return;

    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    if (amount === 0 && qty === 0) return;

    if (!productMap[model]) {
      productMap[model] = { color: classifyEuBgColor(backgrounds[idx][4]), monthly: {} };
    }
    var key = billDate.getFullYear() + "-" + billDate.getMonth();
    if (!productMap[model].monthly[key]) productMap[model].monthly[key] = { qty: 0, amount: 0 };
    productMap[model].monthly[key].qty    += qty;
    productMap[model].monthly[key].amount += amount;
  });

  var capexProducts = [], consumableProducts = [], otherProducts = [];
  Object.keys(productMap).forEach(function(model) {
    var p = productMap[model];
    var monthly = months.map(function(mo) {
      var key = mo.year + "-" + mo.month;
      var d = p.monthly[key] || { qty: 0, amount: 0 };
      return { qty: Math.round(d.qty), amount: Math.round(d.amount) };
    });
    var row = { product: model, monthly: monthly };
    if (p.color === "yellow") consumableProducts.push(row);
    else if (p.color === "red") otherProducts.push(row);
    else capexProducts.push(row);
  });

  capexProducts.sort(function(a, b) { return a.product.localeCompare(b.product); });
  consumableProducts.sort(function(a, b) { return a.product.localeCompare(b.product); });
  otherProducts.sort(function(a, b) { return a.product.localeCompare(b.product); });

  return {
    months: months.map(function(mo) { return mo.label; }),
    capexProducts: capexProducts,
    consumableProducts: consumableProducts,
    otherProducts: otherProducts
  };
}

/* ══════════════════════════════════════════════════
   getPoInHand()
   Powers the "PO In-hand" button (placed right next to
   "Inventory - Item Wise" in the MJ section) and its
   click-to-expand detail table.

   Source: Report!FP:FU (6-col block, FP = col 172) — CONFIRMED
   column mapping:
     FP (col 172) = PO Date          ← formatted "dd MMM yyyy"
     FQ (col 173) = Hospital Name
     FR (col 174) = Product
     FS (col 175) = Quantity
     FT (col 176) = Amount           ← the value summed
     FU (col 177) = (unused / reserved for future use)

   Logic:
   - Every row with a non-blank Hospital Name (FQ) is included —
     no date/month filter (mirrors Inventory - Item Wise, which
     also has no date filter). Rows with a zero/blank Amount are
     still included (so nothing silently disappears) — only rows
     with literally no Hospital Name at all are skipped.
   - total = sum of Amount (FT) across all included rows.
   - PO Date is formatted as "dd MMM yyyy" (e.g. "13 Jul 2026")
     server-side, so the frontend never has to deal with a raw
     JS Date/timestamp string.

   Returns: { total, rows: [ { poDate, hospital, product, qty, amount }, ... ] }
══════════════════════════════════════════════════ */
function getPoInHand() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { total: 0, rows: [] };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { total: 0, rows: [] };

  /* FP=172, 6 cols through FU=177 */
  var data = rep.getRange(2, 172, lastRow - 1, 6).getValues();
  var total = 0;
  var rows  = [];

  data.forEach(function(r) {
    var poDateRaw = r[0]; /* FP */
    var hospital  = String(r[1] || "").trim(); /* FQ */
    var product   = String(r[2] || "").trim(); /* FR */
    var qtyRaw    = r[3]; /* FS */
    var amountRaw = r[4]; /* FT */

    if (!hospital) return; /* skip fully blank rows */

    var amount = typeof amountRaw === "number" ? amountRaw
                 : (parseFloat(String(amountRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    var qty = typeof qtyRaw === "number" ? qtyRaw
              : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    var poDateObj = parseSheetTimestamp(poDateRaw);
    var poDate = poDateObj
      ? Utilities.formatDate(poDateObj, Session.getScriptTimeZone(), "dd MMM yyyy")
      : (poDateRaw ? String(poDateRaw).trim() : "");

    total += amount;
    rows.push({
      poDate   : poDate,
      hospital : hospital,
      product  : product,
      qty      : qty,
      amount   : Math.round(amount)
    });
  });

  return { total: Math.round(total), rows: rows };
}

function getInventoryItemWise() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { companies: [], data: {} };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { companies: [], data: {} };

  var range       = rep.getRange(2, 129, lastRow - 1, 3); /* DY=129, DY:EA (3 cols) */
  var values      = range.getValues();
  var backgrounds = range.getBackgrounds(); /* same shape; [i][0] = DY cell's background color */

  var companyOrder   = [];
  var data            = {};
  var headerOwnValue  = {}; /* company -> {qty, amount} from its OWN header row, if non-zero — only used as a fallback self-item, see below */
  var currentCompany  = null;

  for (var i = 0; i < values.length; i++) {
    var name = String(values[i][0] || "").trim();
    if (!name) continue; /* blank spacer row — skip, keep current company as-is */
    if (/grand\s*total/i.test(name) || name.toLowerCase() === "total") continue; /* summary row, not a company */

    /* Skip non-inventory filler rows entirely — as both a company
       header AND as an item — e.g. "GOVT & OTHERS", "GOVT",
       "Others", "Rents"/"Rental". These aren't real products. */
    var nameLower = name.toLowerCase();
    if (nameLower.indexOf("govt") !== -1 || nameLower.indexOf("other") !== -1 || nameLower.indexOf("rent") !== -1) continue;

    var qtyRaw = values[i][1];
    var amtRaw = values[i][2];
    var qty = typeof qtyRaw === "number" ? qtyRaw : (parseFloat(String(qtyRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var amt = typeof amtRaw === "number" ? amtRaw : (parseFloat(String(amtRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    var bg = String(backgrounds[i][0] || "").toLowerCase();
    /* Company header = any non-white/non-default highlight (yellow
       in this sheet). Plain/unformatted cells come back as "#ffffff". */
    var isCompanyHeader = bg !== "" && bg !== "#ffffff";

    if (isCompanyHeader) {
      currentCompany = name;
      if (companyOrder.indexOf(currentCompany) === -1) {
        companyOrder.push(currentCompany);
        data[currentCompany] = [];
      }
      /* Some header rows (e.g. MEDTRONIC, AMA, BEDFONT) carry a
         sheet SUBTOTAL of their own child items — NOT a separate
         product. We only remember this value here; whether it
         becomes a self-item is decided AFTER the loop, once we
         know whether this company actually has child item rows. */
      if (qty !== 0 || amt !== 0) {
        headerOwnValue[currentCompany] = { qty: qty, amount: amt };
      }
    } else {
      if (!currentCompany) continue;   /* item row before any company header seen — skip */
      if (qty === 0 && amt === 0) continue; /* hide zero/zero rows */
      data[currentCompany].push({ item: name, qty: qty, amount: amt });
    }
  }

  /* Only turn a header's own value into a self-item (named after
     the company, e.g. ERBE, JIANGSU - HEMORRHOIDS) when that
     company ended up with ZERO real child items — i.e. the header
     row IS the only product this company has. If real child items
     exist (MEDTRONIC, AMA, BEDFONT), the header's own number was
     just a subtotal and is correctly left out, avoiding double
     counting in the Grand Total. */
  companyOrder.forEach(function(company) {
    if (data[company].length === 0 && headerOwnValue[company]) {
      data[company].push({
        item   : company,
        qty    : headerOwnValue[company].qty,
        amount : headerOwnValue[company].amount
      });
    }
  });

  return { companies: companyOrder, data: data };
}

/* ══════════════════════════════════════════════════
   getMonthlyCashflow()
   Called from the Accounts section (below "Inventory - Item
   Wise") via google.script.run, or via the
   ?section=monthlyCashflow JSONP fallback in doGet(e).

   Source: Report!EC:EG (5 cols, EC = col 133)
     EC (col 133) = Date
     ED (col 134) = Party Group   ← grouping key
     EE (col 135) = Party Name    (not shown — summary only)
     EF (col 136) = Debit Amount  ← Outflow
     EG (col 137) = Credit Amount ← Inflow

   Logic:
   - Only rows whose EC date falls in the CURRENT calendar month
     (same "automatic" pattern as getMonthlyPayments() — computed
     from the server's current date every call).
   - Grouped by Party Group (ED): each group's Inflow = sum of
     Credit (EG), Outflow = sum of Debit (EF). This is a SUMMARY
     only — individual Party Name (EE) rows are never returned,
     by design (compact UI requirement).
   - Groups sorted by total activity (inflow+outflow) descending.

   Returns:
     {
       groups      : [ { group, inflow, outflow }, ... ],
       totalInflow : N,
       totalOutflow: N,
       netCashflow : N,   (totalInflow - totalOutflow)
       monthLabel  : "July 2026"
     }
══════════════════════════════════════════════════ */
function getMonthlyCashflow() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  var emptyResult = { groups: [], totalInflow: 0, totalOutflow: 0, netCashflow: 0, monthLabel: "", openingBalance: 0 };
  if (!rep) return emptyResult;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return emptyResult;

  /* Opening Balance This Month — Report!EJ1 (col 140, row 1).
     A single fixed value, NOT part of the grouped inflow/outflow
     data below, and NOT included in any total. */
  var openingBalanceRaw = rep.getRange(1, 140).getValue(); /* EJ1 */
  var openingBalance = typeof openingBalanceRaw === "number" ? openingBalanceRaw
                        : (parseFloat(String(openingBalanceRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();

  /* EC=133, 5 cols through EG=137 */
  var data = rep.getRange(2, 133, lastRow - 1, 5).getValues();
  var groupMap   = {};
  var groupOrder = [];

  data.forEach(function(r) {
    var dateRaw      = r[0];
    var partyGroup   = String(r[1] || "").replace(/\u00A0/g, " ").trim(); /* normalize NBSP too */
    var debitRaw     = r[3];
    var creditRaw    = r[4];

    if (!partyGroup && !dateRaw) return; /* skip fully blank rows */

    var d = parseSheetTimestamp(dateRaw);
    if (!d) return;
    if (d.getMonth() !== curMonth || d.getFullYear() !== curYear) return; /* current month only */

    if (!partyGroup) partyGroup = "(Unspecified)";

    var debit = typeof debitRaw === "number" ? debitRaw
                : (parseFloat(String(debitRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    var credit = typeof creditRaw === "number" ? creditRaw
                 : (parseFloat(String(creditRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    /* "Sundry Debtors" — a debit here means money owed TO us went up
       (a receivable), not real cash going out. So it should never
       count toward Outflow for this group, even though the sheet
       has a Debit Amount value for it. */
    if (partyGroup.toLowerCase() === "sundry debtors") debit = 0;

    /* Group by a CASE/WHITESPACE-NORMALIZED key so "Digital Marketing",
       "DIGITAL MARKETING", "digital marketing " etc. all land in the
       SAME bucket instead of silently fragmenting the total across
       several near-duplicate groups (this was the root cause of
       totals looking too small — only one spelling variant's rows
       were being shown, the rest were sitting in other invisible
       buckets). The display label keeps the FIRST-SEEN original
       spelling/casing so the UI still looks natural. */
    var groupKey = partyGroup.toLowerCase();

    if (!groupMap[groupKey]) {
      groupMap[groupKey] = { group: partyGroup, inflow: 0, outflow: 0 };
      groupOrder.push(groupKey);
    }
    groupMap[groupKey].inflow  += credit;
    groupMap[groupKey].outflow += debit;
  });

  var groups = groupOrder.map(function(g) { return groupMap[g]; });
  /* Busiest groups (highest combined inflow+outflow) first */
  groups.sort(function(a, b) { return (b.inflow + b.outflow) - (a.inflow + a.outflow); });

  var totalInflow  = groups.reduce(function(s, g) { return s + g.inflow;  }, 0);
  var totalOutflow = groups.reduce(function(s, g) { return s + g.outflow; }, 0);

  var monthLabel = Utilities.formatDate(
    new Date(curYear, curMonth, 1),
    Session.getScriptTimeZone(),
    "MMMM yyyy"
  );

  return {
    groups         : groups,
    openingBalance : Math.round(openingBalance),
    totalInflow  : Math.round(totalInflow),
    totalOutflow : Math.round(totalOutflow),
    netCashflow  : Math.round(totalInflow - totalOutflow),
    monthLabel   : monthLabel
  };
}

/* ══════════════════════════════════════════════════
   getExecutiveData(email)
   Returns ALL raw rows from Report tab where column BS
   (col 71, "Email address") == the given email.
   Reusable for any future report on this column block.
══════════════════════════════════════════════════ */
function getExecutiveData(email) {
  if (!email) throw new Error("getExecutiveData: email is required");
  email = String(email).trim().toLowerCase();

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) throw new Error('Sheet "' + REPORT_TAB + '" not found.');

  var lastRow = rep.getLastRow();
  if (lastRow < 2) {
    return { email: email, name: execNameFromEmail(email), rows: [], count: 0 };
  }

  /* BR:BW = cols 70-75 (6 cols)
     BR=Timestamp BS=Email BT=Hospital BU=City BV=Demo Product BW=RSM Name */
  var startCol = 70; /* BR */
  var numCols  = 6;  /* BR..BW */
  var dataRows = rep.getRange(2, startCol, lastRow - 1, numCols).getValues();

  var rows = [];
  dataRows.forEach(function(r) {
    var rowEmail = String(r[1] || "").trim().toLowerCase();   /* BS */
    if (rowEmail !== email) return;

    var ts       = r[0];
    var hospital = String(r[2] || "").trim();   /* BT */
    var city     = String(r[3] || "").trim();   /* BU */
    var product  = String(r[4] || "").trim();   /* BV */
    var rsmName  = String(r[5] || "").trim();   /* BW */

    var tsOut = "";
    if (ts instanceof Date) tsOut = ts.toISOString();
    else if (ts) tsOut = String(ts);

    rows.push({
      timestamp : tsOut,
      email     : rowEmail,
      hospital  : hospital,
      city      : city,
      product   : product,
      rsm       : rsmName
    });
  });

  return {
    email : email,
    name  : execNameFromEmail(email),
    rows  : rows,
    count : rows.length
  };
}

/* ══════════════════════════════════════════════════
   countProspectiveCustomers(email)
   "Prospective Customers" = total rows where BS == email.
   Kept separate so other reports/cards can reuse it without
   re-reading the whole sheet block.
══════════════════════════════════════════════════ */
function countProspectiveCustomers(email) {
  if (!email) return 0;
  email = String(email).trim().toLowerCase();

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return 0;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return 0;

  /* BS = col 71, single column read is cheapest for a pure count */
  var emails = rep.getRange(2, 71, lastRow - 1, 1).getValues();
  var count = 0;
  for (var i = 0; i < emails.length; i++) {
    var e = String(emails[i][0] || "").trim().toLowerCase();
    if (e === email) count++;
  }
  return count;
}

/* ── helper: resolve display name for an email ── */
function execNameFromEmail(email) {
  email = String(email || "").trim().toLowerCase();
  for (var i = 0; i < SALES_EXECUTIVES.length; i++) {
    if (SALES_EXECUTIVES[i].email.toLowerCase() === email) return SALES_EXECUTIVES[i].name;
  }
  return email;
}

/* ── helper: resolve RSM for an email via SALES_EXECUTIVES directory ── */
function rsmFromEmail(email) {
  email = String(email || "").trim().toLowerCase();
  for (var i = 0; i < SALES_EXECUTIVES.length; i++) {
    if (SALES_EXECUTIVES[i].email.toLowerCase() === email) return SALES_EXECUTIVES[i].rsm || "Unassigned";
  }
  return "Unassigned";
}

/* ══════════════════════════════════════════════════
   getRangeMetricData(startCol, totalKey)
   Generic 6-column reader shared by every "count rows per
   Sales Executive email" report (Wants Demo, Demo Done -
   Quotation Pending, and any future one added the same way).

   Expects columns in this fixed order starting at startCol:
     [0] Timestamp  [1] Email (Sales Executive)  [2] Hospital
     [3] City       [4] Demo Product             [5] RSM Name

   Cleans data:
     - blank emails are dropped
     - emails are trimmed + lowercased before grouping
     - fully-blank rows are skipped (no duplicate-empty inflation)

   Returns:
     {
       byExecutive: { email: {email,name,rsm,count,cities:{},products:{}} },
       byRsm: {
         rsmName: { rsm, [totalKey]: N, executives:[ {...}, sorted desc by count ] }
       }
     }
══════════════════════════════════════════════════ */
function getRangeMetricData(startCol, totalKey) {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { byExecutive: {}, byRsm: {} };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { byExecutive: {}, byRsm: {} };

  var rows = rep.getRange(2, startCol, lastRow - 1, 6).getValues();
  var byExecutive = {};

  rows.forEach(function(r) {
    var ts       = r[0];
    var email    = String(r[1] || "").trim().toLowerCase();
    var hospital = String(r[2] || "").trim();
    var city     = String(r[3] || "").trim();
    var product  = String(r[4] || "").trim();
    var rsmCell  = String(r[5] || "").trim();

    if (!email) return;                                  /* remove blank emails */
    if (!ts && !hospital && !city && !product) return;    /* ignore duplicate/blank rows */

    if (!byExecutive[email]) {
      byExecutive[email] = {
        email     : email,
        name      : execNameFromEmail(email),
        rsm       : rsmCell || null,
        count     : 0,
        cities    : {},
        products  : {},
        hospitals : {} /* { hospitalName: { productName: count } } — used for the Hospital→Product→Count breakdown */
      };
    }
    var ex = byExecutive[email];
    ex.count++;
    if (!ex.rsm && rsmCell) ex.rsm = rsmCell;
    if (city) ex.cities[city] = (ex.cities[city] || 0) + 1;
    if (product) {
      product.split(',').forEach(function(p) {
        p = p.trim();
        if (p) ex.products[p] = (ex.products[p] || 0) + 1;
      });
    }
    if (hospital) {
      if (!ex.hospitals[hospital]) ex.hospitals[hospital] = {};
      var prodList = product ? product.split(',').map(function(p){ return p.trim(); }).filter(Boolean) : [];
      if (prodList.length) {
        prodList.forEach(function(p) {
          ex.hospitals[hospital][p] = (ex.hospitals[hospital][p] || 0) + 1;
        });
      } else {
        /* No product listed for this row — still record the hospital so it's not silently dropped */
        ex.hospitals[hospital]["(No product listed)"] = (ex.hospitals[hospital]["(No product listed)"] || 0) + 1;
      }
    }
  });

  Object.keys(byExecutive).forEach(function(email) {
    var ex = byExecutive[email];
    if (!ex.rsm) ex.rsm = rsmFromEmail(email);
  });

  var byRsm = {};
  Object.keys(byExecutive).forEach(function(email) {
    var ex  = byExecutive[email];
    var key = ex.rsm || "Unassigned";
    if (!byRsm[key]) {
      byRsm[key] = { rsm: key, executives: [] };
      byRsm[key][totalKey] = 0;
    }
    byRsm[key].executives.push(ex);
    byRsm[key][totalKey] += ex.count;
  });
  Object.keys(byRsm).forEach(function(r) {
    byRsm[r].executives.sort(function(a, b) { return b.count - a.count; });
  });

  return { byExecutive: byExecutive, byRsm: byRsm };
}

/* ══════════════════════════════════════════════════
   getProspectiveCustomersData()
   Source: Report!BR:BW (6 cols) — BR=70
     BR=Timestamp BS=Email BT=Hospital BU=City BV=Product BW=RSM
   Each row = one "Prospective Customer" record. Same range
   getExecutiveData() reads, exposed here in the same shape as
   the other metric readers so it can be merged into the
   grouped Sales Executive Reports table.
══════════════════════════════════════════════════ */
function getProspectiveCustomersData() {
  return getRangeMetricData(70, "totalProspectiveCustomers");
}

/* ══════════════════════════════════════════════════
   getWantsDemoData()
   Source: Report!BY:CD (6 cols) — BY=77
     BY=Timestamp BZ=Email CA=Hospital CB=City CC=Product CD=RSM
   Each row = one "Wants Demo" request.
══════════════════════════════════════════════════ */
function getWantsDemoData() {
  return getRangeMetricData(77, "totalWantsDemo");
}

/* ══════════════════════════════════════════════════
   getDemoDoneData()
   Source: Report!CF:CK (6 cols) — CF=84
     CF=Timestamp CG=Email CH=Hospital CI=City CJ=Product CK=RSM
   Each row = one "Demo Done - Quotation Pending" record.
══════════════════════════════════════════════════ */
function getDemoDoneData() {
  return getRangeMetricData(84, "totalDemoDonePending");
}

/* ══════════════════════════════════════════════════
   getQuotationSubmittedData()
   Source: Report!CM:CR (6 cols) — CM=91
     CM=Timestamp CN=Email CO=Hospital CP=City CQ=Product CR=RSM
   Each row = one "Quotation Submitted" record.
══════════════════════════════════════════════════ */
function getQuotationSubmittedData() {
  return getRangeMetricData(91, "totalQuotationSubmitted");
}

/* ══════════════════════════════════════════════════
   countWantsDemo(email)
   "Wants Demo" = total rows where BZ == email (normalised).
══════════════════════════════════════════════════ */
function countWantsDemo(email) {
  if (!email) return 0;
  email = String(email).trim().toLowerCase();
  var data = getWantsDemoData();
  var ex = data.byExecutive[email];
  return ex ? ex.count : 0;
}

/* ══════════════════════════════════════════════════
   countDemoDonePending(email)
   "Demo Done - Quotation Pending" = total rows where CG == email.
══════════════════════════════════════════════════ */
function countDemoDonePending(email) {
  if (!email) return 0;
  email = String(email).trim().toLowerCase();
  var data = getDemoDoneData();
  var ex = data.byExecutive[email];
  return ex ? ex.count : 0;
}

/* ══════════════════════════════════════════════════
   countQuotationSubmitted(email)
   "Quotation Submitted" = total rows where CN == email.
══════════════════════════════════════════════════ */
function countQuotationSubmitted(email) {
  if (!email) return 0;
  email = String(email).trim().toLowerCase();
  var data = getQuotationSubmittedData();
  var ex = data.byExecutive[email];
  return ex ? ex.count : 0;
}

/* ══════════════════════════════════════════════════
   getSalesExecutiveReports()
   Merges Prospective Customers + Wants Demo + Demo Done -
   Quotation Pending + Quotation Submitted into a single
   per-executive, RSM-grouped report so the dashboard can show
   all four metrics together without four separate API shapes.

   Returns:
     {
       byExecutive: { email: {
         email, name, rsm,
         prospectiveCustomers, wantsDemo, demoDonePending, quotationSubmitted,
         prospectiveCities, prospectiveProducts,
         wantsDemoCities, wantsDemoProducts,
         demoDoneCities, demoDoneProducts,
         quotationCities, quotationProducts
       } },
       byRsm: {
         rsmName: {
           rsm, totalProspectiveCustomers, totalWantsDemo,
           totalDemoDonePending, totalQuotationSubmitted,
           executives: [ {...same shape}, sorted desc by combined total ]
         }
       }
     }
══════════════════════════════════════════════════ */
function getSalesExecutiveReports() {
  var pc = getProspectiveCustomersData();
  var wd = getWantsDemoData();
  var dd = getDemoDoneData();
  var qs = getQuotationSubmittedData();

  var allEmails = {};
  Object.keys(pc.byExecutive).forEach(function(e) { allEmails[e] = true; });
  Object.keys(wd.byExecutive).forEach(function(e) { allEmails[e] = true; });
  Object.keys(dd.byExecutive).forEach(function(e) { allEmails[e] = true; });
  Object.keys(qs.byExecutive).forEach(function(e) { allEmails[e] = true; });

  var byExecutive = {};
  Object.keys(allEmails).forEach(function(email) {
    var p = pc.byExecutive[email];
    var w = wd.byExecutive[email];
    var d = dd.byExecutive[email];
    var q = qs.byExecutive[email];
    var rsm = (p && p.rsm) || (w && w.rsm) || (d && d.rsm) || (q && q.rsm) || rsmFromEmail(email);
    byExecutive[email] = {
      email                 : email,
      name                  : execNameFromEmail(email),
      rsm                   : rsm,
      prospectiveCustomers  : p ? p.count    : 0,
      wantsDemo             : w ? w.count    : 0,
      demoDonePending       : d ? d.count    : 0,
      quotationSubmitted    : q ? q.count    : 0,
      prospectiveCities     : p ? p.cities   : {},
      prospectiveProducts   : p ? p.products : {},
      prospectiveHospitals  : p ? p.hospitals : {},
      wantsDemoCities       : w ? w.cities   : {},
      wantsDemoProducts     : w ? w.products : {},
      wantsDemoHospitals    : w ? w.hospitals : {},
      demoDoneCities        : d ? d.cities   : {},
      demoDoneProducts      : d ? d.products : {},
      demoDoneHospitals     : d ? d.hospitals : {},
      quotationCities       : q ? q.cities   : {},
      quotationProducts     : q ? q.products : {},
      quotationHospitals    : q ? q.hospitals : {}
    };
  });

  var byRsm = {};
  Object.keys(byExecutive).forEach(function(email) {
    var ex  = byExecutive[email];
    var key = ex.rsm || "Unassigned";
    if (!byRsm[key]) {
      byRsm[key] = {
        rsm: key,
        totalProspectiveCustomers: 0,
        totalWantsDemo: 0,
        totalDemoDonePending: 0,
        totalQuotationSubmitted: 0,
        executives: []
      };
    }
    byRsm[key].executives.push(ex);
    byRsm[key].totalProspectiveCustomers += ex.prospectiveCustomers;
    byRsm[key].totalWantsDemo            += ex.wantsDemo;
    byRsm[key].totalDemoDonePending      += ex.demoDonePending;
    byRsm[key].totalQuotationSubmitted   += ex.quotationSubmitted;
  });
  Object.keys(byRsm).forEach(function(r) {
    byRsm[r].executives.sort(function(a, b) {
      return (b.prospectiveCustomers + b.wantsDemo + b.demoDonePending + b.quotationSubmitted) -
             (a.prospectiveCustomers + a.wantsDemo + a.demoDonePending + a.quotationSubmitted);
    });
  });

  return { byExecutive: byExecutive, byRsm: byRsm };
}

/* ══════════════════════════════════════════════════
   getTargetVsAchievement()
   Called from the Sales Executive Reports view ("Target Vs
   Achievement" section, shown just below the Prospective/
   Wants Demo/Demo Done/Quotation Submitted table) via
   google.script.run, or via the ?section=targetVsAchievement
   JSONP fallback in doGet(e).

   Source: Report!CY:DB (4 cols, CY = col 103)
     CY (col 103) = Sales Executive Name
     CZ (col 104) = Email address        ← SKIP, not used here
     DA (col 105) = Target
     DB (col 106) = Achievement

   Logic:
   - One row per Sales Executive Name found in CY — used exactly
     as it appears in the sheet (no fuzzy matching against
     SALES_EXECUTIVES; the sheet is the source of truth here).
   - EVERY executive with a non-blank name is included, even if
     Achievement is 0 — only rows with a truly blank name are
     skipped.
   - No caching / hardcoding — reads the live sheet every call.

   Returns: [ { name, target, achievement }, ... ] in sheet row order.
══════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════
   getUniqueAddedThisMonth()
   Called from getTargetVsAchievement() to attach a "Unique
   Added" count to each Sales Executive's Target vs Achievement
   row.

   Source: Report!DD:DG (4 cols, DD = col 108)
     DD (col 108) = Sales Executive ID (email)
     DE (col 109) = Hospital Name
     DF (col 110) = (unused)
     DG (col 111) = Date of visit  ← filter column

   Logic:
   - Only rows whose DG date falls in the CURRENT calendar month
     (computed from the server's date every call — no hardcoded
     month, and future dates are excluded since they can't be
     "this month" unless the sheet has bad data, which this also
     guards against).
   - For each Sales Executive email, count UNIQUE hospital names
     (case-insensitive) — duplicate hospital visits in the same
     month count once.

   Returns: { "email@x.com": count, ... } (lowercased email keys)
══════════════════════════════════════════════════ */
var _uniqueAddedRawCache = null; /* memoized within a single request — avoids scanning AR:AT twice */

function computeUniqueAddedRaw() {
  if (_uniqueAddedRawCache) return _uniqueAddedRawCache;

  var emailMonthSets = {}, emailWeekSets = {}; /* email -> { hospitalLower: true } */
  var rsmMonthSets = {}, rsmWeekSets = {};     /* rsm   -> { hospitalLower: true } */
  var weekStart = "", weekEnd = "";

  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var rep = ss.getSheetByName(REPORT_TAB);
    if (rep) {
      var lastRow = rep.getLastRow();
      if (lastRow >= 2) {
        /* Email -> RSM lookup — shared single source of truth,
           includes both SALES_EXECUTIVES (subordinates) and
           RSM_DIRECT_EMAILS (RSMs' own emails). */
        var rsmByEmail = buildEmailToRsmLookup();

        var today = new Date();
        var curMonth = today.getMonth(), curYear = today.getFullYear();
        var currentWeek = getCurrentWeekMonToSat();
        var lastMonday = currentWeek.start;
        var lastSunday = currentWeek.end; /* current week Mon-Sat end-of-day; kept as lastSunday var name only to avoid renaming usages below */
        weekStart = lastMonday.toISOString();
        weekEnd   = lastSunday.toISOString();


        /* Read AR:AT = 3 cols from col 44 (AR=Date of Visit,
           AS=Hospital Name, AT=Sales Executive Email) — REPLACES
           the old Report!DD:DG / AR1:AT6 sources, per the sheet's
           updated structure. */
        var data = rep.getRange(2, 44, lastRow - 1, 3).getValues();

        data.forEach(function(r) {
          var visitRaw = r[0]; /* AR */
          var hospital = String(r[1] || "").trim(); /* AS */
          var email    = String(r[2] || "").trim().toLowerCase(); /* AT */

          if (!email || !hospital) return;

          var visitDate = parseSheetTimestamp(visitRaw);
          if (!visitDate) return;         /* invalid/empty date → skip */
          if (visitDate > today) return;  /* future date → skip */

          var hospitalKey = hospital.toLowerCase();
          var rsm = rsmByEmail[email]; /* may be undefined if email isn't mapped — still counted per-email below */

          if (visitDate.getMonth() === curMonth && visitDate.getFullYear() === curYear) {
            if (!emailMonthSets[email]) emailMonthSets[email] = {};
            emailMonthSets[email][hospitalKey] = true;
            if (rsm) {
              if (!rsmMonthSets[rsm]) rsmMonthSets[rsm] = {};
              rsmMonthSets[rsm][hospitalKey] = true;
            }
          }
          if (visitDate >= lastMonday && visitDate <= lastSunday) {
            if (!emailWeekSets[email]) emailWeekSets[email] = {};
            emailWeekSets[email][hospitalKey] = true;
            if (rsm) {
              if (!rsmWeekSets[rsm]) rsmWeekSets[rsm] = {};
              rsmWeekSets[rsm][hospitalKey] = true;
            }
          }
        });
      }
    }
  } catch (e) {
    Logger.log("computeUniqueAddedRaw ERROR: " + e.message);
  }

  function countMap(setsObj) {
    var out = {};
    Object.keys(setsObj).forEach(function(k) { out[k] = Object.keys(setsObj[k]).length; });
    return out;
  }

  _uniqueAddedRawCache = {
    emailMonthCounts: countMap(emailMonthSets),
    emailWeekCounts:  countMap(emailWeekSets),
    rsmMonthCounts:   countMap(rsmMonthSets),
    rsmWeekCounts:    countMap(rsmWeekSets),
    weekStart: weekStart,
    weekEnd: weekEnd
  };
  return _uniqueAddedRawCache;
}

/* Thin wrapper — preserves getUniqueAddedThisMonth()'s EXACT old
   return shape (plain { email: count } object), so every existing
   caller (Sales Executive Reports' Unique Added panel, Target vs
   Achievement) keeps working unchanged. Internally now powered by
   computeUniqueAddedRaw() (Report!AR:AT), replacing the old
   Report!DD:DG source. */
function getUniqueAddedThisMonth() {
  return computeUniqueAddedRaw().emailMonthCounts;
}

/* Thin wrapper — preserves getUniqueAddedThisWeek()'s EXACT old
   return shape ({ counts, weekStart, weekEnd }). */
function getUniqueAddedThisWeek() {
  var raw = computeUniqueAddedRaw();
  return { counts: raw.emailWeekCounts, weekStart: raw.weekStart, weekEnd: raw.weekEnd };
}


/* ══════════════════════════════════════════════════
   getUniqueAddedThisMonthReport()
   Powers the standalone "Unique Added This Month" button/page
   (next to the Sales Executive Reports filter bar) — a full
   list of unique-hospital-visit rows for the CURRENT MONTH,
   sorted by Date of Visit ASCENDING (oldest first, latest last).

   This is a SEPARATE function from getUniqueAddedThisMonth()
   above (which only returns per-email COUNTS, used for the
   Target vs Achievement / Unique Added KPI panels) — this one
   returns the actual RAW ROWS for a detailed report table, and
   reads one extra column (DF = City) that the counts version
   doesn't need.

   Source: Report!DD:DG (4 cols, DD = col 108)
     DD (col 108) = Sales Executive ID (email)
     DE (col 109) = Hospital Name
     DF (col 110) = City
     DG (col 111) = Date of Visit

   RSM + Name lookup: the sheet has no RSM/Name columns here, so
   each row's RSM and Sales Executive NAME are both looked up
   from the SAME SALES_EXECUTIVES directory used everywhere else
   in this file (matched by email, case-insensitive) — no
   separate/duplicate mapping. execId (the raw email) is still
   included in the output for reference; execName is what the
   frontend displays instead of the email.

   Logic:
   - Only rows where Date of Visit falls in the CURRENT calendar
     month (which, being "now", is always inside the current
     Financial Year too — no separate FY check needed).
   - Blank rows and invalid/unparseable dates are skipped.
   - Sorted by Date of Visit ASCENDING (oldest → latest), on the
     actual parsed Date object so this is correct regardless of
     the sheet's date string format.

   Returns: [ { date, hospital, city, execId, execName, rsm }, ... ]
══════════════════════════════════════════════════ */
function getUniqueAddedThisMonthReport() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return [];

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return [];

  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();

  /* Email -> RSM lookup — shared single source of truth (includes
     RSM_DIRECT_EMAILS too, so a row where the RSM personally
     logged the visit is no longer silently dropped). */
  var rsmByEmail = buildEmailToRsmLookup();

  /* Email -> Name lookup, from the existing SALES_EXECUTIVES
     directory — no new/duplicate mapping created. RSM_DIRECT_EMAILS
     entries don't have a "name" (they're keyed straight to the RSM
     name), so those fall back to using the RSM name itself. */
  var nameByEmail = {};
  SALES_EXECUTIVES.forEach(function(ex) {
    var e = String(ex.email || "").trim().toLowerCase();
    if (e) nameByEmail[e] = ex.name;
  });
  Object.keys(RSM_DIRECT_EMAILS).forEach(function(email) {
    nameByEmail[email.trim().toLowerCase()] = RSM_DIRECT_EMAILS[email];
  });

  /* DD=108, 4 cols through DG=111 */
  var data = rep.getRange(2, 108, lastRow - 1, 4).getValues();
  var rows = [];

  data.forEach(function(r) {
    var execId   = String(r[0] || "").trim(); /* DD */
    var hospital = String(r[1] || "").trim(); /* DE */
    var city     = String(r[2] || "").trim(); /* DF */
    var visitRaw = r[3];                       /* DG */

    if (!execId && !hospital) return; /* ignore fully blank rows */

    var visitDate = parseSheetTimestamp(visitRaw);
    if (!visitDate) return; /* ignore invalid/unparseable dates */
    if (visitDate.getMonth() !== curMonth || visitDate.getFullYear() !== curYear) return; /* current month only */

    var execIdLower = execId.toLowerCase();
    var rsm      = rsmByEmail[execIdLower] || "Unassigned";
    var execName = nameByEmail[execIdLower] || execId; /* fall back to the raw ID if no name is mapped */

    rows.push({
      date     : visitDate.toISOString(),
      hospital : hospital,
      city     : city,
      execId   : execId,
      execName : execName,
      rsm      : rsm
    });
  });

  /* Sort by Date of Visit ASCENDING — oldest entry first, latest
     last. Replaces the previous RSM-hierarchy grouping. Sorting
     on the actual parsed Date object (not the raw sheet string),
     so this is correct regardless of the sheet's date format. */
  rows.sort(function(a, b) {
    return new Date(a.date) - new Date(b.date);
  });

  return rows;
}

/* ══════════════════════════════════════════════════
   getDemoDoneActivityThisMonth() / getDemoDoneActivityThisWeek()
   Power the "Demo Done" panel (shown right below "Unique Added"
   in the Sales Executive Reports view) — same This Month / This
   Week structure, but a different source and a SIMPLE entry
   count (not a unique-hospital count).

   Source: Report!CF:CK (only CF and CG are used here)
     CF (col 84) = Timestamp   ← filter column
     CG (col 85) = Sales Executive Email  ← grouping key

   NOTE: A function named getDemoDoneData() already exists in
   this file for a different report ("Demo Done - Quotation
   Pending" — city/product breakdown), reading the same CF:CK
   block for a different purpose. These are separate, new
   functions with different names so nothing there is touched.

   Logic (This Month): count ALL rows (not unique) whose CF
   falls in the current calendar month, grouped by CG email.
   Logic (This Week): same, but CF falls within the last
   completed Monday–Sunday week (identical week math to
   getUniqueAddedThisWeek()).
   Both skip invalid/empty dates and future dates.

   Returns: { "email@x.com": count, ... } (This Month version)
   or        { counts: {...}, weekStart, weekEnd } (This Week version)
══════════════════════════════════════════════════ */
function getDemoDoneActivityThisMonth() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return {};

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return {};

  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();

  /* CF=84, only need 2 cols (CF, CG) */
  var data = rep.getRange(2, 84, lastRow - 1, 2).getValues();
  var counts = {};

  data.forEach(function(r) {
    var tsRaw = r[0]; /* CF */
    var email = String(r[1] || "").trim().toLowerCase(); /* CG */
    if (!email) return;

    var d = parseSheetTimestamp(tsRaw);
    if (!d) return;          /* invalid/empty date → skip */
    if (d > now) return;     /* future date → skip */
    if (d.getMonth() !== curMonth || d.getFullYear() !== curYear) return;

    counts[email] = (counts[email] || 0) + 1;
  });

  return counts;
}

function getDemoDoneActivityThisWeek() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return { counts: {}, weekStart: "", weekEnd: "" };

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return { counts: {}, weekStart: "", weekEnd: "" };

  var today = new Date();
  var currentWeek = getCurrentWeekMonToSat();
  var lastMonday = currentWeek.start;
  var lastSunday = currentWeek.end; /* current week Mon-Sat end-of-day */

  /* CF=84, only need 2 cols (CF, CG) */
  var data = rep.getRange(2, 84, lastRow - 1, 2).getValues();
  var counts = {};

  data.forEach(function(r) {
    var tsRaw = r[0];
    var email = String(r[1] || "").trim().toLowerCase();
    if (!email) return;

    var d = parseSheetTimestamp(tsRaw);
    if (!d) return;
    if (d < lastMonday || d > lastSunday) return;

    counts[email] = (counts[email] || 0) + 1;
  });

  return { counts: counts, weekStart: lastMonday.toISOString(), weekEnd: lastSunday.toISOString() };
}

/* ══════════════════════════════════════════════════
   getExpectedSaleRowsThisMonth()
   Powers the "Expected Sale This Month" panel (shown right
   below "Demo Done" in the Sales Executive Reports view).

   Source: Report!AV:BA (6 cols, AV = col 48)
     AV (col 48) = Timestamp                ← filter column
     AW (col 49) = Hospital Name
     AX (col 50) = Demo Product
     AY (col 51) = State
     AZ (col 52) = Sales Executive Email    ← grouping key
     BA (col 53) = Approx Expecting Sale

   Logic:
   - Only rows whose AV falls in the current calendar month
     (invalid/empty/future dates skipped).
   - Rows with a zero/blank Approx Expecting Sale are skipped.
   - Grouped by Sales Executive email — each email's rows kept
     as a plain list (Hospital, State, Product, Sale), not
     aggregated, since this panel is meant to show the raw
     entries per executive.

   Returns: { "email@x.com": [ {hospital, state, product, sale}, ... ], ... }
══════════════════════════════════════════════════ */
function getExpectedSaleRowsThisMonth() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return {};

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return {};

  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();

  /* AV=48, 6 cols through BA=53 */
  var data = rep.getRange(2, 48, lastRow - 1, 6).getValues();
  var byEmail = {};

  data.forEach(function(r) {
    var tsRaw    = r[0]; /* AV */
    var hospital = String(r[1] || "").trim(); /* AW */
    var product  = String(r[2] || "").trim(); /* AX */
    var state    = String(r[3] || "").trim(); /* AY */
    var email    = String(r[4] || "").trim().toLowerCase(); /* AZ */
    var saleRaw  = r[5]; /* BA */

    if (!email) return;

    var d = parseSheetTimestamp(tsRaw);
    if (!d) return;          /* invalid/empty date → skip */
    if (d > now) return;     /* future date → skip */
    if (d.getMonth() !== curMonth || d.getFullYear() !== curYear) return;

    var sale = typeof saleRaw === "number" ? saleRaw
               : (parseFloat(String(saleRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    if (sale <= 0) return; /* skip empty/zero sale values */

    if (!byEmail[email]) byEmail[email] = [];
    byEmail[email].push({
      hospital : hospital,
      state    : state,
      product  : product,
      sale     : Math.round(sale)
    });
  });

  return byEmail;
}

/* ══════════════════════════════════════════════════
   getAllExpectedSaleRows()
   Powers the "All Expected Sale" panel (shown right below
   "Expected Sale This Month" in the Sales Executive Reports
   view). Unlike Expected Sale This Month, this has NO date
   filter — it returns every row, regardless of when it was
   entered.

   Source: Report!BC:BH (6 cols, BC = col 55) — SAME range/
   column layout already verified and used by the "Product Wise
   Pipeline (YTD)" section elsewhere in this file:
     BC (col 55) = Timestamp        (not used for filtering here)
     BD (col 56) = Hospital Name
     BE (col 57) = Demo Product
     BF (col 58) = State
     BG (col 59) = Sales Executive Email  ← grouping key
     BH (col 60) = Approx Expecting Sale

   Logic:
   - NO month/date filter — every row with a valid email and a
     positive sale value is included.
   - Grouped by Sales Executive email, each as a plain list of
     {hospital, state, product, sale} (not aggregated).

   Returns: { "email@x.com": [ {hospital, state, product, sale}, ... ], ... }
══════════════════════════════════════════════════ */
function getAllExpectedSaleRows() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return {};

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return {};

  /* BC=55, 6 cols through BH=60 */
  var data = rep.getRange(2, 55, lastRow - 1, 6).getValues();
  var byEmail = {};

  data.forEach(function(r) {
    var hospital = String(r[1] || "").trim(); /* BD */
    var product  = String(r[2] || "").trim(); /* BE */
    var state    = String(r[3] || "").trim(); /* BF */
    var email    = String(r[4] || "").trim().toLowerCase(); /* BG */
    var saleRaw  = r[5]; /* BH */

    if (!email) return; /* skip rows with no email — can't attribute to an executive */

    var sale = typeof saleRaw === "number" ? saleRaw
               : (parseFloat(String(saleRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
    if (sale <= 0) return; /* skip empty/zero sale values */

    if (!byEmail[email]) byEmail[email] = [];
    byEmail[email].push({
      hospital : hospital,
      state    : state,
      product  : product,
      sale     : Math.round(sale)
    });
  });

  return byEmail;
}

/* ══════════════════════════════════════════════════
   getProspectiveCustomersList()
   Powers the standalone "PROSPECTIVE CUSTOMERS" section (its
   own button + same-page section, next to Accounts/HR).

   NOTE: this is a DIFFERENT function from the existing
   getProspectiveCustomersData() (which powers a different,
   unrelated Sales-Executive report from Report!BR:BW) — kept as
   a separate name so nothing there is touched.

   Source: Report!BJ:BP (7 cols, BJ = col 62) — same block
   already used by the "RSM Wise Total Expected Sale" forecast
   feature elsewhere in this file:
     BJ (col 62) = Hospital Name
     BK (col 63) = Demo Product
     BL (col 64) = State
     BM (col 65) = Expected Sale Month
     BN (col 66) = Sales Executive Email  ← intentionally NOT
                                             returned; the UI
                                             must not show it
     BO (col 67) = Approx Expecting Sale
     BP (col 68) = RSM Name

   Returns each row already in the requested DISPLAY order
   (Hospital, State, Product, Month, Sale, RSM) as an object —
   the frontend just renders these fields directly, in this
   order, with no email field present at all.

   Returns: [ { hospital, state, product, month, sale, rsm }, ... ]
══════════════════════════════════════════════════ */
function getProspectiveCustomersList() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return [];

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return [];

  /* BJ=62, 7 cols through BP=68 */
  var data = rep.getRange(2, 62, lastRow - 1, 7).getValues();
  var rows = [];

  data.forEach(function(r) {
    var hospital = String(r[0] || "").trim(); /* BJ */
    var product  = String(r[1] || "").trim(); /* BK */
    var state    = String(r[2] || "").trim(); /* BL */
    var monthRaw = r[3];                       /* BM */
    /* r[4] = BN = Sales Executive Email — read but never included below */
    var saleRaw  = r[5];                       /* BO */
    var rsm      = String(r[6] || "").trim();  /* BP */

    if (!hospital) return; /* skip fully blank rows */

    var month;
    if (monthRaw instanceof Date) {
      month = Utilities.formatDate(monthRaw, Session.getScriptTimeZone(), "MMM yyyy");
    } else {
      month = String(monthRaw || "").trim();
    }

    var sale = typeof saleRaw === "number" ? saleRaw
               : (parseFloat(String(saleRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

    rows.push({
      hospital : hospital,
      state    : state,
      product  : product,
      month    : month,
      sale     : Math.round(sale),
      rsm      : rsm
    });
  });

  return rows;
}

/* ══════════════════════════════════════════════════
   getSalesExecDetailReport()
   Powers the "Sales Executive Detail" report in the HR section.

   Source: Report!EZ:FL (13 cols, EZ = col 156)
     EZ (col 156) = Name
     FA (col 157) = Date of Joining
     FB (col 158) = Physical training in office? (checkbox)
     FC (col 159) = Fibroscan   (checkbox)
     FD (col 160) = Manoscan    (checkbox)
     FE (col 161) = ABT         (checkbox)
     FF (col 162) = HBT         (checkbox)
     FG (col 163) = CE          (checkbox)
     FH (col 164) = Digitrapper (checkbox)
     FI (col 165) = Endoflip    (checkbox)
     FJ (col 166) = CBD         (checkbox)
     FK (col 167) = EHL         (checkbox)
     FL (col 168) = Inbody      (checkbox)

   Logic:
   - One row per employee with a non-blank Name (EZ).
   - Physical Training → "Yes" if the FB checkbox is checked,
     else "No".
   - Products Trained → comma-joined list of every product
     (FC..FL) whose checkbox is checked, e.g. "Fibroscan, ABT,
     Digitrapper". Empty string if none are checked.
   - Date of Joining is formatted DD/MM/YYYY when it's a real
     date; otherwise shown as-is from the sheet.

   Returns: [ { name, doj, physicalTraining, products }, ... ]
══════════════════════════════════════════════════ */
var SALES_EXEC_TRAINING_PRODUCTS = ["Fibroscan", "Manoscan", "ABT", "HBT", "CE", "Digitrapper", "Endoflip", "CBD", "EHL", "Inbody"];

function isTruthyCheckbox(val) {
  if (val === true) return true;
  if (val === false || val === null || val === undefined || val === "") return false;
  var s = String(val).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1" || s === "✓" || s === "checked";
}

function getSalesExecDetailReport() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return [];

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return [];

  /* EZ=156, 13 cols through FL=168 */
  var data = rep.getRange(2, 156, lastRow - 1, 13).getValues();
  var rows = [];

  data.forEach(function(r) {
    var name = String(r[0] || "").trim(); /* EZ */
    if (!name) return; /* skip fully blank rows */

    var dojRaw = r[1]; /* FA */
    var doj;
    if (dojRaw instanceof Date) {
      doj = Utilities.formatDate(dojRaw, Session.getScriptTimeZone(), "dd/MM/yyyy");
    } else {
      var parsedDoj = parseSheetTimestamp(dojRaw);
      doj = parsedDoj ? Utilities.formatDate(parsedDoj, Session.getScriptTimeZone(), "dd/MM/yyyy")
                       : (dojRaw ? String(dojRaw).trim() : "");
    }

    var physicalTraining = isTruthyCheckbox(r[2]) ? "Yes" : "No"; /* FB */

    var trainedProducts = [];
    var productFlags = {}; /* keyed by lowercase product name, e.g. productFlags.fibroscan = true/false */
    for (var i = 0; i < SALES_EXEC_TRAINING_PRODUCTS.length; i++) {
      var checked = isTruthyCheckbox(r[3 + i]); /* FC..FL */
      productFlags[SALES_EXEC_TRAINING_PRODUCTS[i].toLowerCase()] = checked;
      if (checked) trainedProducts.push(SALES_EXEC_TRAINING_PRODUCTS[i]);
    }

    rows.push({
      name             : name,
      doj              : doj,
      physicalTraining : physicalTraining,
      products         : trainedProducts.join(", "), /* kept for backward-compat, no longer shown in the UI */
      fibroscan   : productFlags["fibroscan"],
      manoscan    : productFlags["manoscan"],
      abt         : productFlags["abt"],
      hbt         : productFlags["hbt"],
      ce          : productFlags["ce"],
      digitrapper : productFlags["digitrapper"],
      endoflip    : productFlags["endoflip"],
      cbd         : productFlags["cbd"],
      ehl         : productFlags["ehl"],
      inbody      : productFlags["inbody"]
    });
  });

  return rows;
}

/* ══════════════════════════════════════════════════
   getHRSummary()
   Powers the 3 summary boxes (Total Hiring / Completed /
   Pending) at the top of the HR section, PLUS the click-to-view
   detail table (Task + Deadline only) below them.

   Source: Report!EL:EO (4 cols, EL = col 142)
     EL (col 142) = Employee Name
     EM (col 143) = Task
     EN (col 144) = Deadline
     EO (col 145) = Status (Complete / Pending / blank)

   Logic:
   - Total Hiring = every row with a non-blank Employee Name (EL).
   - Completed    = rows where Status (EO) is "Complete" (or
                    "Completed" — either spelling accepted),
                    case-insensitive.
   - Pending      = every other row with a name (Status is
                    "Pending", blank, or anything else that isn't
                    "Complete").
   So Total Hiring = Completed + Pending always.

   Returns:
     {
       totalHiring, completed, pending,
       rows: [ { task, deadline, status }, ... ]
     }
   where status is normalized to exactly "complete" or "pending"
   (frontend filters on this, not the raw sheet text). Name (EL)
   is intentionally NOT included in rows — the detail table only
   ever shows Task + Deadline, per the requirement.
══════════════════════════════════════════════════ */
function getHRSummary() {
  var empty = { totalHiring: 0, completed: 0, pending: 0, rows: [], thisMonthHiring: 0, lastMonthHiring: 0 };
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return empty;

  var lastRow = rep.getLastRow();
  if (lastRow < 2) return empty;

  /* This Month / Last Month window — auto-computed from the
     server's current date every call, with Dec→Jan rollover
     handled (no hardcoded month). */
  var now      = new Date();
  var curMonth = now.getMonth();
  var curYear  = now.getFullYear();
  var lastMonth     = curMonth === 0 ? 11 : curMonth - 1;
  var lastMonthYear = curMonth === 0 ? curYear - 1 : curYear;

  /* EL=142, 4 cols through EO=145 */
  var data = rep.getRange(2, 142, lastRow - 1, 4).getValues();
  var totalHiring = 0, completed = 0, pending = 0;
  var thisMonthHiring = 0, lastMonthHiring = 0;
  var rows = [];

  data.forEach(function(r) {
    var name        = String(r[0] || "").trim(); /* EL */
    var task        = String(r[1] || "").trim(); /* EM */
    var deadlineRaw = r[2];                       /* EN */
    var status      = String(r[3] || "").trim().toLowerCase(); /* EO */

    if (!name) return; /* skip fully blank rows */

    totalHiring++;
    var isCompleted = (status === "complete" || status === "completed");
    if (isCompleted) completed++; else pending++;

    var deadlineDate = parseSheetTimestamp(deadlineRaw); /* ignores empty/invalid dates automatically (returns null) */
    if (deadlineDate) {
      if (deadlineDate.getMonth() === curMonth && deadlineDate.getFullYear() === curYear) {
        thisMonthHiring++;
      }
      if (deadlineDate.getMonth() === lastMonth && deadlineDate.getFullYear() === lastMonthYear) {
        lastMonthHiring++;
      }
    }

    var deadlineOut = deadlineDate ? deadlineDate.toISOString()
                       : (deadlineRaw ? String(deadlineRaw).trim() : "");

    rows.push({
      task     : task,
      deadline : deadlineOut,
      status   : isCompleted ? "complete" : "pending"
    });
  });

  return {
    totalHiring     : totalHiring,
    completed       : completed,
    pending         : pending,
    rows            : rows,
    thisMonthHiring : thisMonthHiring,
    lastMonthHiring : lastMonthHiring
  };
}

/* ══════════════════════════════════════════════════
   getTargetVsAchievement()  — CACHED WRAPPER (60s)
   This section (Target Vs Achievement + Unique Added + Demo
   Done + Expected Sale This Month + All Expected Sale) does 6+
   full-sheet scans internally (see computeTargetVsAchievement()
   below). That's heavy enough that recomputing it on every
   single Sales Executive dropdown click was making the whole
   Sales Executive Reports view feel like it was stuck loading —
   not an error, just genuinely slow, especially noticeable when
   switching between executives quickly. This wraps the real
   computation in a 60-second ScriptCache, same pattern as
   getDashboardData()'s CACHE_KEY, so only the FIRST call in any
   60s window pays the full cost — every call after that (e.g.
   switching from one executive to another) returns instantly
   from cache.
══════════════════════════════════════════════════ */
var TVA_CACHE_KEY     = "gm_tva_cache_v1";
var TVA_CACHE_SECONDS = 60;

function getTargetVsAchievement(forceRefresh) {
  var cache = CacheService.getScriptCache();
  if (!forceRefresh) {
    try {
      var cached = cache.get(TVA_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      Logger.log("getTargetVsAchievement cache read failed: " + e.message);
    }
  }

  var results = computeTargetVsAchievement();

  try {
    cache.put(TVA_CACHE_KEY, JSON.stringify(results), TVA_CACHE_SECONDS);
  } catch (e) {
    Logger.log("getTargetVsAchievement cache write failed (result may be too large): " + e.message);
  }

  return results;
}

function computeTargetVsAchievement() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) return [];

  var uniqueAddedMap       = getUniqueAddedThisMonth();
  var uniqueWeekData       = getUniqueAddedThisWeek();
  var demoDoneMonthMap     = getDemoDoneActivityThisMonth();
  var demoDoneWeekData     = getDemoDoneActivityThisWeek();
  var expectedSaleRowsMap  = getExpectedSaleRowsThisMonth();
  var allExpectedSaleMap   = getAllExpectedSaleRows();

  /* ── Build a Target/Achievement lookup keyed by EMAIL (not name)
     from Report!CY:DB. Email is far more reliable to match on than
     a free-text name (case/spacing/spelling variants), and this is
     also what lets a brand-new executive who hasn't been given a
     CY:DB row yet still show up correctly below. ── */
  var targetByEmail = {}; /* emailLower -> {name, target, achievement} */
  var lastRow = rep.getLastRow();
  if (lastRow >= 2) {
    /* CY=103, 4 cols through DB=106 (CY, CZ, DA, DB) */
    var data = rep.getRange(2, 103, lastRow - 1, 4).getValues();
    data.forEach(function(r) {
      var name = String(r[0] || "").trim();
      var email = String(r[1] || "").trim().toLowerCase(); /* CZ */
      if (!name && !email) return;

      var targetRaw     = r[2]; /* DA */
      var achievementRaw = r[3]; /* DB */
      var target = typeof targetRaw === "number" ? targetRaw
                   : (parseFloat(String(targetRaw || "0").replace(/[^0-9.-]/g, "")) || 0);
      var achievement = typeof achievementRaw === "number" ? achievementRaw
                         : (parseFloat(String(achievementRaw || "0").replace(/[^0-9.-]/g, "")) || 0);

      var key = email || ("__noemail__" + name.toLowerCase()); /* fall back to name-based key only if truly no email */
      targetByEmail[key] = { name: name, email: email, target: Math.round(target), achievement: Math.round(achievement) };
    });
  }

  /* ── Master list = every known Sales Executive (SALES_EXECUTIVES),
     PLUS any CY:DB email that isn't already in that directory (so a
     row is never silently dropped just because the directory is out
     of date). Every executive gets an entry here regardless of
     whether they have a CY:DB row yet — target/achievement just
     default to 0 until one exists. ── */
  var seenEmails = {};
  var masterList = [];

  SALES_EXECUTIVES.forEach(function(ex) {
    var emailLower = String(ex.email || "").trim().toLowerCase();
    if (!emailLower || seenEmails[emailLower]) return;
    seenEmails[emailLower] = true;
    var cyRow = targetByEmail[emailLower];
    masterList.push({
      name  : cyRow ? cyRow.name : ex.name, /* prefer the exact sheet spelling if a CY:DB row exists */
      email : emailLower,
      target      : cyRow ? cyRow.target      : 0,
      achievement : cyRow ? cyRow.achievement : 0
    });
  });

  /* Include any CY:DB rows whose email wasn't in SALES_EXECUTIVES at all */
  Object.keys(targetByEmail).forEach(function(key) {
    var row = targetByEmail[key];
    var emailLower = row.email;
    if (emailLower && !seenEmails[emailLower]) {
      seenEmails[emailLower] = true;
      masterList.push({ name: row.name, email: emailLower, target: row.target, achievement: row.achievement });
    } else if (!emailLower) {
      /* No email at all on this CY:DB row — still surface it by name so the row isn't lost,
         but it won't be able to match Unique Added/Demo Done/Expected Sale (those need an email). */
      masterList.push({ name: row.name, email: "", target: row.target, achievement: row.achievement });
    }
  });

  var results = masterList.map(function(m) {
    var email = m.email;
    return {
      name              : m.name,
      target            : m.target,
      achievement       : m.achievement,
      uniqueAdded       : email ? (uniqueAddedMap[email] || 0) : 0,
      uniqueAddedWeek   : email ? (uniqueWeekData.counts[email] || 0) : 0,
      weekStart         : uniqueWeekData.weekStart,
      weekEnd           : uniqueWeekData.weekEnd,
      demoDoneMonth     : email ? (demoDoneMonthMap[email] || 0) : 0,
      demoDoneWeek      : email ? (demoDoneWeekData.counts[email] || 0) : 0,
      demoDoneWeekStart : demoDoneWeekData.weekStart,
      demoDoneWeekEnd   : demoDoneWeekData.weekEnd,
      expectedSaleRows  : email ? (expectedSaleRowsMap[email] || []) : [],
      allExpectedSaleRows : email ? (allExpectedSaleMap[email] || []) : []
    };
  });

  return results;
}

/* ══════════════════════════════════════════════════
   getExecutiveDashboardData(email)
   Single payload for the Executive detail page:
     - prospectiveCount     (report #1: count + city/product breakdown)
     - wantsDemo            (report #2: count + city/product breakdown)
     - demoDonePending      (report #3: count + city/product breakdown)
     - quotationSubmitted   (report #4: count + city/product breakdown)
     - rows                 (raw matching rows, for future reports)
     - execList              (so the dropdown can be rebuilt client-side)
══════════════════════════════════════════════════ */
function getExecutiveDashboardData(email) {
  var data = getExecutiveData(email);
  var key  = String(email || "").trim().toLowerCase();
  var pc   = getProspectiveCustomersData();
  var wd   = getWantsDemoData();
  var dd   = getDemoDoneData();
  var qs   = getQuotationSubmittedData();
  var exPc = pc.byExecutive[key] || null;
  var exWd = wd.byExecutive[key] || null;
  var exDd = dd.byExecutive[key] || null;
  var exQs = qs.byExecutive[key] || null;

  return {
    email                      : data.email,
    name                       : data.name,
    prospectiveCount           : countProspectiveCustomers(email),
    prospectiveCities          : exPc ? exPc.cities   : {},
    prospectiveProducts        : exPc ? exPc.products : {},
    prospectiveHospitals       : exPc ? exPc.hospitals : {},
    wantsDemo                  : exWd ? exWd.count    : 0,
    wantsDemoCities            : exWd ? exWd.cities   : {},
    wantsDemoProducts          : exWd ? exWd.products : {},
    wantsDemoHospitals         : exWd ? exWd.hospitals : {},
    demoDonePending            : exDd ? exDd.count    : 0,
    demoDonePendingCities      : exDd ? exDd.cities   : {},
    demoDonePendingProducts    : exDd ? exDd.products : {},
    demoDonePendingHospitals   : exDd ? exDd.hospitals : {},
    quotationSubmitted         : exQs ? exQs.count    : 0,
    quotationSubmittedCities   : exQs ? exQs.cities   : {},
    quotationSubmittedProducts : exQs ? exQs.products : {},
    quotationSubmittedHospitals: exQs ? exQs.hospitals : {},
    rows                       : data.rows,
    execList                   : SALES_EXECUTIVES,
    generatedAt                : new Date().toISOString()
  };
}

/* ══════════════════════════════════════════════════
   parseSheetTimestamp(raw)  — HARDENED (v21)
   Robust Timestamp (col T) parser.

   Handles:
   - Real Date objects (normal case) → returned as-is, no ambiguity.
   - Numeric spreadsheet serial dates (rare CSV-import edge case).
   - STRING timestamps in DD/MM/YYYY (Indian) format, with or
     without time, with or without AM/PM, with different
     separators (/ - .), and with stray non-breaking spaces
     that sometimes sneak in from copy-paste.
   - Falls back to native Date parsing only as last resort.

   This was the exact root cause of the wrong/missing Demo
   Trend numbers before: JS's native `new Date(str)` assumes
   MM/DD/YYYY (US format), which:
       • silently SWAPS day/month when day <= 12
         e.g. "02/07/2026" → wrongly becomes 7 Feb instead of 2 July
       • returns Invalid Date when day > 12 (month becomes >12)
         e.g. "29/06/2026" → dropped entirely (isNaN → skipped)
   We parse DD/MM/YYYY explicitly instead of trusting the
   native string parser, and now also tolerate AM/PM suffixes
   and stray whitespace so no valid row is silently dropped.
══════════════════════════════════════════════════ */
function parseSheetTimestamp(raw) {
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  if (raw === null || raw === undefined || raw === "") return null;

  /* Numeric serial date (Sheets epoch = 30 Dec 1899) */
  if (typeof raw === "number") {
    var epoch = new Date(Math.round((raw - 25569) * 86400 * 1000));
    return isNaN(epoch.getTime()) ? null : epoch;
  }

  var s = String(raw).trim().replace(/\u00A0/g, " "); /* normalize NBSP */
  if (!s) return null;

  /* DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY, optional time, optional AM/PM */
  var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[\s,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?$/);
  if (m) {
    var day   = parseInt(m[1], 10);
    var month = parseInt(m[2], 10) - 1;   /* DD/MM/YYYY → month is 2nd group */
    var year  = parseInt(m[3], 10);
    var hh    = m[4] ? parseInt(m[4], 10) : 0;
    var mi    = m[5] ? parseInt(m[5], 10) : 0;
    var ss    = m[6] ? parseInt(m[6], 10) : 0;
    var ap    = m[7] ? m[7].toLowerCase() : null;
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;

    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      var d = new Date(year, month, day, hh, mi, ss);
      if (!isNaN(d.getTime())) return d;
    }
  }

  /* Fallback: let JS try (covers ISO strings etc.) */
  var fallback = new Date(s);
  return isNaN(fallback.getTime()) ? null : fallback;
}

/* ── helper: match a raw RSM cell value (col W) to the canonical
   RSM_NAMES spelling, case/whitespace insensitive — so a stray
   "daya " or "DAYA" still lands in the correct bucket instead of
   silently forming an invisible extra group. (v21) ── */
function canonicalRsmName(raw) {
  var s = String(raw || "").trim();
  if (!s) return "";
  for (var i = 0; i < RSM_NAMES.length; i++) {
    if (RSM_NAMES[i].toLowerCase() === s.toLowerCase()) return RSM_NAMES[i];
  }
  return s; /* unknown RSM name — keep as-is, still shown, never dropped */
}

/* ══════════════════════════════════════════════════
   computeDemoTrend()  — HARDENED (v21)
   Reads Report!T:W independently.
   T (col 20) = Timestamp  →  extracts YYYY-MM month key
   W (col 23) = RSM Name   →  canonicalized, then grouped by this
   Returns: { "Vijay": {"2026-07":3,"2026-06":5}, "Daya": {...}, ... }
   Called from getDashboardData AND testable via ?section=demoTrend URL.
══════════════════════════════════════════════════ */
var _demoActivityRawCache = null; /* memoized within a single request — avoids scanning P:R twice */

function computeDemoActivityRaw() {
  if (_demoActivityRawCache) return _demoActivityRawCache;

  var trend = {};          /* trend[rsm][ "YYYY-MM" ] = count — 6-month history */
  var weekByRsm = {};      /* weekByRsm[rsm] = count — current Mon-Sun week */
  var monthByRsm = {};     /* monthByRsm[rsm] = count — current calendar month */
  var rowsRead = 0;
  var skippedNoEmailOrTs = 0;
  var skippedUnmappedEmail = 0;
  var skippedParseFail = 0;
  var countedRows = 0;
  var sampleLog = [];
  var weekStart = "", weekEnd = "";

  try {
    var ss  = SpreadsheetApp.getActiveSpreadsheet();
    var rep = ss.getSheetByName(REPORT_TAB);
    if (!rep) { Logger.log("computeDemoActivityRaw: sheet '" + REPORT_TAB + "' NOT FOUND"); }
    else {
      var last = rep.getLastRow();
      if (last >= 2) {
        /* Email -> RSM lookup — shared single source of truth,
           includes both SALES_EXECUTIVES (subordinates) and
           RSM_DIRECT_EMAILS (RSMs' own emails). */
        var rsmByEmail = buildEmailToRsmLookup();

        var today = new Date();
        var curMonth = today.getMonth(), curYear = today.getFullYear();
        var currentWeek = getCurrentWeekMonToSat();
        var lastMonday = currentWeek.start;
        var lastSunday = currentWeek.end; /* current week Mon-Sat end-of-day */
        weekStart = lastMonday.toISOString();
        weekEnd   = lastSunday.toISOString();

        /* Read P:R = 3 cols from col 16 (P=Timestamp, Q=unused,
           R=Sales Executive Email) — REPLACES the old T:W
           (Timestamp + RSM Name directly) / P1:R6 (pre-aggregated
           summary) sources, per the sheet's updated structure. */
        var rows = rep.getRange(2, 16, last - 1, 3).getValues();
        rowsRead = rows.length;
        for (var i = 0; i < rows.length; i++) {
          var ts       = rows[i][0];                       /* P = Timestamp */
          var emailRaw = String(rows[i][2] || "").trim();   /* R = Sales Executive Email */

          if (i < 5) {
            sampleLog.push("row" + (i+2) + ": ts=[" + ts + "] type=" + (typeof ts) +
                            (ts instanceof Date ? " (Date obj)" : "") +
                            " email=[" + emailRaw + "]");
          }

          if (!emailRaw || !ts) { skippedNoEmailOrTs++; continue; }

          var d = parseSheetTimestamp(ts);
          if (!d) { skippedParseFail++; continue; }

          var rsm = rsmByEmail[emailRaw.toLowerCase()];
          if (!rsm) { skippedUnmappedEmail++; continue; } /* email not found in SALES_EXECUTIVES */

          var mo  = d.getMonth() + 1;
          var key = d.getFullYear() + "-" + (mo < 10 ? "0" + mo : "" + mo);
          if (!trend[rsm]) trend[rsm] = {};
          trend[rsm][key] = (trend[rsm][key] || 0) + 1;
          countedRows++;

          if (d.getMonth() === curMonth && d.getFullYear() === curYear) {
            monthByRsm[rsm] = (monthByRsm[rsm] || 0) + 1;
          }
          if (d >= lastMonday && d <= lastSunday) {
            weekByRsm[rsm] = (weekByRsm[rsm] || 0) + 1;
          }
        }
        Logger.log("computeDemoActivityRaw: rowsRead=" + rowsRead +
                   " counted=" + countedRows +
                   " skippedNoEmailOrTs=" + skippedNoEmailOrTs +
                   " skippedUnmappedEmail=" + skippedUnmappedEmail +
                   " skippedParseFail=" + skippedParseFail);
      }
    }
  } catch(e) {
    Logger.log("computeDemoActivityRaw ERROR: " + e.message + " | stack: " + e.stack);
  }

  _demoActivityRawCache = {
    trend: trend,
    weekByRsm: weekByRsm,
    monthByRsm: monthByRsm,
    weekStart: weekStart,
    weekEnd: weekEnd,
    _rowCount: rowsRead,
    _debug: {
      rowsRead: rowsRead,
      countedRows: countedRows,
      skippedNoEmailOrTs: skippedNoEmailOrTs,
      skippedUnmappedEmail: skippedUnmappedEmail,
      skippedParseFail: skippedParseFail,
      sample: sampleLog
    }
  };
  return _demoActivityRawCache;
}

/* Thin wrapper — preserves computeDemoTrend()'s EXACT old return
   shape (result[rsm][key]=count, plus _rowCount/_debug merged in
   at the top level) so every existing caller (Demo Trend widget,
   debug routes, etc.) keeps working unchanged. Internally now
   powered by computeDemoActivityRaw() (Report!P:R), replacing the
   old Report!T:W source. */
function computeDemoTrend() {
  var raw = computeDemoActivityRaw();
  var result = {};
  Object.keys(raw.trend).forEach(function(rsm) { result[rsm] = raw.trend[rsm]; });
  result._rowCount = raw._rowCount;
  result._debug = raw._debug;
  return result;

}

/* ══════════════════════════════════════════════════
   getDashboardData(forceRefresh)

══════════════════════════════════════════════════ */

function getDashboardData(forceRefresh) {

  var cache = CacheService.getScriptCache();
  /* Clear old cache versions to avoid stale data */
  ["gm_dash_v11","gm_dash_v12","gm_dash_v13","gm_dash_v14","gm_dash_v15",
   "gm_dash_v16","gm_dash_v17","gm_dash_v18","gm_dash_v19","gm_dash_v20",
   "gm_dash_v32","gm_dash_v33"].forEach(function(k){
    try { cache.remove(k); } catch(e) {}
  });
  if (!forceRefresh) {
    var cached = cache.get(CACHE_KEY);
    if (cached) {
      try { var p = JSON.parse(cached); p.fromCache = true; return p; }
      catch (e) { /* corrupt */ }
    }
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) throw new Error('Sheet "' + REPORT_TAB + '" not found.');

  /* ── Init RSM buckets ── */
  var rsms = {};
  RSM_NAMES.forEach(function(n) {
    rsms[n] = {
      name: n, target: 0, sale: 0, pending: 0,
      achievement: 0, pipelineMonth: 0,
      demoWeek: 0, demoMonth: 0,
      uniqueWk: 0, uniqueMo: 0,
      funnel: { prospective: 0, wantsDemo: 0, demoDone: 0, quoteSubmitted: 0 }
    };
  });

  /* ── 1. SCORECARD Report!A2:F6 ── */
  rep.getRange("A2:F6").getValues().forEach(function(row) {
    var name = String(row[0]).trim();
    if (!rsms[name]) return;
    rsms[name].target        = Number(row[1]) || 0;
    rsms[name].sale          = Number(row[2]) || 0;
    rsms[name].pending       = Number(row[3]) || 0;
    var pct = row[4];
    rsms[name].achievement   = (typeof pct === "number")
      ? (pct < 1 ? pct * 100 : pct) : (parseFloat(String(pct)) || 0);
    rsms[name].pipelineMonth = Number(row[5]) || 0;
  });

  /* ── 2a. DEMO ACTIVITY — Report!P:R (Timestamp + Sales Executive
     Email, RSM looked up via SALES_EXECUTIVES). REPLACES the old
     pre-aggregated Report!P1:R6 summary block, per the sheet's
     updated structure. Shares its scan with computeDemoTrend()
     via computeDemoActivityRaw()'s same-request memoization, so
     Report!P:R is only scanned once even though both this section
     and the Demo Trend widget need it. ── */
  try {
    var demoRaw = computeDemoActivityRaw();
    RSM_NAMES.forEach(function(n) {
      rsms[n].demoWeek  = demoRaw.weekByRsm[n]  || 0;
      rsms[n].demoMonth = demoRaw.monthByRsm[n] || 0;
    });
  } catch(e) { Logger.log("WARN: Demo Activity (P:R): " + e.message); }

  /* ── 2b. UNIQUE CUSTOMERS — Report!AR:AT (Date of Visit +
     Hospital Name + Sales Executive Email, RSM looked up via
     SALES_EXECUTIVES). REPLACES the old pre-aggregated
     Report!AR1:AT6 summary block, per the sheet's updated
     structure. TRUE unique-hospital de-duplication per RSM (a
     hospital visited twice by the same RSM in the same window
     only counts once). Shares its scan with
     getUniqueAddedThisMonth()/getUniqueAddedThisWeek() via
     computeUniqueAddedRaw()'s same-request memoization. ── */
  try {
    var uniqRaw = computeUniqueAddedRaw();
    RSM_NAMES.forEach(function(n) {
      rsms[n].uniqueWk = uniqRaw.rsmWeekCounts[n]  || 0;
      rsms[n].uniqueMo = uniqRaw.rsmMonthCounts[n] || 0;
    });
  } catch(e) { Logger.log("WARN: Unique Customers (AR:AT): " + e.message); }

  /* ── 3. PIPELINE BY STAGE Report!H1:N5 ── */
  var stageAll = rep.getRange("H1:N5").getValues();
  var stageHdr = stageAll[0];
  var colToRSM = {};
  stageHdr.forEach(function(cell, ci) {
    var h = String(cell).trim();
    RSM_NAMES.forEach(function(rn) {
      if (h === rn || rn.toLowerCase().indexOf(h.toLowerCase()) === 0 ||
          h.toLowerCase().indexOf(rn.toLowerCase()) === 0) colToRSM[ci] = rn;
    });
  });
  if (Object.keys(colToRSM).length < RSM_NAMES.length) {
    var pos = { 1: RSM_NAMES[0], 2: RSM_NAMES[1], 3: RSM_NAMES[2], 4: RSM_NAMES[3], 5: RSM_NAMES[4] };
    Object.keys(pos).forEach(function(ci) { if (!colToRSM[ci]) colToRSM[ci] = pos[ci]; });
  }
  var STAGE_KEYS = ["prospective", "wantsDemo", "demoDone", "quoteSubmitted"];
  stageAll.slice(1).forEach(function(row, ri) {
    var key = STAGE_KEYS[ri];
    if (!key) return;
    Object.keys(colToRSM).forEach(function(ci) {
      rsms[colToRSM[ci]].funnel[key] = Number(row[Number(ci)]) || 0;
    });
  });

  /* ── 4. LEADS Report!AD2:AI ── */
  var leadsMap = {};
  RSM_NAMES.forEach(function(n) { leadsMap[n] = []; });
  leadsMap["Unassigned"] = [];
  var lastRow = rep.getLastRow();
  if (lastRow >= 2) {
    var leadRows = rep.getRange(2, 30, lastRow - 1, 6).getValues();
    var seen = {};
    leadRows.forEach(function(row) {
      var hospital = String(row[0] || "").trim();
      if (!hospital) return;
      var product = String(row[1] || "").trim();
      var state   = String(row[2] || "").trim();
      var value   = Number(row[4]) || 0;
      if (value <= 0) return;
      var rsm = String(row[5] || "").trim();
      var key = hospital.slice(0, 40) + "|" + value;
      if (seen[key]) return;
      seen[key] = true;
      var lead = { hospital: hospital, product: product, state: state, value: value };
      if (rsm && leadsMap[rsm]) leadsMap[rsm].push(lead);
      else leadsMap["Unassigned"].push(lead);
    });
  }
  Object.keys(leadsMap).forEach(function(rsm) {
    leadsMap[rsm].sort(function(a, b) { return b.value - a.value; });
  });

  /* ══════════════════════════════════════════════
     5+6+7. PRODUCT WISE EXPECTED SALE THIS MONTH
            Source: Report!AV:BA  (AV = col 48, 6 cols)
              AV (col 48) = Timestamp          -- THIS MONTH filter
              AW (col 49) = Hospital Name      -- dedup key (part 1)
              AX (col 50) = Demo Product(s)    -- comma-separated; dedup key (part 2)
              AY (col 51) = State
              AZ (col 52) = Sales Executive Email (not used here)
              BA (col 53) = Approx Expecting Sale -- actual deal value from sheet

            Logic:
            1. Current-month rows only (AV timestamp).
            2. Split AX by comma, each product treated separately.
            3. Unique key = Hospital + Product; duplicate combo = skip.
            4. BA value split equally among products in that row
               ("ABT, CBD" @ Rs19000 -> ABT Rs9500 + CBD Rs9500).
            5. Group by product: QTY = unique hospitals,
               VALUE = sum of allocated BA values.
            No hardcoded / predefined prices used anywhere.
  ══════════════════════════════════════════════ */
  var priceMap    = {};   /* kept empty - no longer used for products */
  var prodCustMap = {};   /* product -> [{hospital, state, value}] for UI detail expand */
  var products    = [];

  try {
    var avLastRow = rep.getLastRow();

    if (avLastRow >= 2) {
      /* SIMPLEST POSSIBLE LOGIC — mirrors SUMIF(AX:AX, product, BA:BA).
         AV=col48 AW=col49 AX=col50 AY=col51 AZ=col52 BA=col53
         Current-month rows only (AV timestamp). No dedup, no
         splitting — every current-month row with a valid BA is
         counted (this comment was previously wrong/stale — the
         date filter below was missing entirely and has now been
         restored to match what this section's name promises). */
      var avRows = rep.getRange(2, 48, avLastRow - 1, 6).getValues();
      var prodValueMap = {};
      var avNow      = new Date();
      var avCurMonth = avNow.getMonth();
      var avCurYear  = avNow.getFullYear();

      avRows.forEach(function(row) {
        var tsRaw    = row[0];                        /* AV = Timestamp */
        var hospital = String(row[1] || "").trim();  /* AW */
        var prodKey  = String(row[2] || "").trim();  /* AX */
        /* Normalize: sort products alphabetically so same products in any
           order map to the same group key.
           "CBD, ABT, Fluorecare" → "ABT, CBD, Fluorecare" (same as "ABT, CBD, Fluorecare") */
        if (prodKey) {
          prodKey = prodKey.split(",")
            .map(function(p){ return p.trim(); })
            .filter(Boolean)
            .sort()
            .join(", ");
        }
        var state    = String(row[3] || "").trim();  /* AY */
        var baVal    = row[5];                       /* BA — GAS returns as Number */

        if (!prodKey) return;

        /* THIS MONTH filter — restores the behavior already
           documented above (AV = Timestamp) but never actually
           implemented; without this, every month's rows were
           being mixed together instead of just the current one. */
        var tsDate = parseSheetTimestamp(tsRaw);
        if (!tsDate) return;
        if (tsDate.getMonth() !== avCurMonth || tsDate.getFullYear() !== avCurYear) return;

        /* BA is a Number from GAS getValues() — no string parsing needed */
        var amt = typeof baVal === "number" ? baVal : parseFloat(String(baVal).replace(/[^0-9.-]/g, "")) || 0;
        if (amt <= 0) return;

        if (!prodValueMap[prodKey]) prodValueMap[prodKey] = { count: 0, value: 0 };
        prodValueMap[prodKey].count++;
        prodValueMap[prodKey].value += amt;

        if (!prodCustMap[prodKey]) prodCustMap[prodKey] = [];
        prodCustMap[prodKey].push({ hospital: hospital, state: state, value: Math.round(amt) });
      });

      products = Object.keys(prodValueMap).map(function(k) {
        return { product: k, qty: prodValueMap[k].count, unitPrice: 0, value: Math.round(prodValueMap[k].value) };
      }).sort(function(a, b) { return b.value - a.value; });

      Logger.log("=== PRODUCT TOTALS ===");
      var grandTotal = 0;
      products.forEach(function(p) {
        Logger.log(p.product + " | qty:" + p.qty + " | value:" + p.value);
        grandTotal += p.value;
      });
      Logger.log("GRAND TOTAL: " + grandTotal);
    }
  } catch(eProd) { Logger.log("WARN: products AV:BA: " + eProd.message); }

  /* ══════════════════════════════════════════════
     8+9. PRODUCT WISE PIPELINE (YTD)
            Source: Report!BC:BH  (BC = col 55, 6 cols)
              BC (col 55) = Timestamp          ← no date filter (all YTD)
              BD (col 56) = Hospital Name
              BE (col 57) = Demo Product(s)    ← comma-separated
              BF (col 58) = State
              BG (col 59) = Sales Executive Email (ignored)
              BH (col 60) = Approx Expecting Sale ← VALUE (same as BA in monthly)

            Logic IDENTICAL to monthly section (AV:BA) — same column positions,
            same normalization, same SUMIF logic. Only difference: NO date filter.

            Normalization: Split BE → sort alphabetically → rejoin.
            "CBD, ABT" and "ABT, CBD" → both become "ABT, CBD" (same group).
            No deduplication. Every row counted. No price lookup — BH IS the value.
  ══════════════════════════════════════════════ */
  var priceMapYtd    = {};   /* not used */
  var prodCustMapYtd = {};
  var productsYtd    = [];

  try {
    var bcLastRow = rep.getLastRow();
    if (bcLastRow >= 2) {
      /* BC = col 55, read 6 cols → BC BD BE BF BG BH */
      var bcRows = rep.getRange(2, 55, bcLastRow - 1, 6).getValues();
      var ytdMap = {};

      bcRows.forEach(function(row) {
        /* row[0]=BC(Timestamp) row[1]=BD(Hospital) row[2]=BE(Product)
           row[3]=BF(State)    row[4]=BG(Email)    row[5]=BH(Value) */
        var hospital = String(row[1] || "").trim();  /* BD */
        var prodCell = String(row[2] || "").trim();  /* BE */
        var state    = String(row[3] || "").trim();  /* BF */
        var bhVal    = row[5];                       /* BH — Approx Expecting Sale */

        if (!prodCell) return;

        /* Normalize: split → sort alphabetically → rejoin (same as monthly) */
        var normalKey = prodCell.split(",")
          .map(function(p){ return p.trim(); })
          .filter(Boolean)
          .sort()
          .join(", ");

        if (!normalKey) return;

        /* BH value — GAS returns as Number, handle string fallback */
        var amt = typeof bhVal === "number" ? bhVal
                  : parseFloat(String(bhVal || "0").replace(/[^0-9.-]/g, "")) || 0;
        if (amt <= 0) return;

        if (!ytdMap[normalKey]) ytdMap[normalKey] = { count: 0, value: 0 };
        ytdMap[normalKey].count++;
        ytdMap[normalKey].value += amt;

        if (!prodCustMapYtd[normalKey]) prodCustMapYtd[normalKey] = [];
        prodCustMapYtd[normalKey].push({ hospital: hospital, state: state, value: Math.round(amt) });
      });

      productsYtd = Object.keys(ytdMap).map(function(k) {
        return { product: k, qty: ytdMap[k].count, unitPrice: 0, value: Math.round(ytdMap[k].value) };
      }).sort(function(a, b) { return b.value - a.value; });

      var ytdTotal = productsYtd.reduce(function(s,p){ return s + p.value; }, 0);
      Logger.log("YTD products: " + productsYtd.length + " | grand total: " + ytdTotal);
    }
  } catch(ePY) { Logger.log("WARN: productsYtd BC:BH: " + ePY.message); }

  /* ══════════════════════════════════════════════
     10. PRODUCT MONTHLY FORECAST  Report!BJ:BO
  ══════════════════════════════════════════════ */
  var MONTH3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function normMonth(raw) {
    if (!raw) return "";
    if (raw instanceof Date) return MONTH3[raw.getMonth()];
    var s = String(raw).trim();
    if (!s) return "";
    var sl = s.toLowerCase();
    for (var mi = 0; mi < MONTH3.length; mi++) {
      var m3 = MONTH3[mi].toLowerCase();
      var mFull = ["january","february","march","april","may","june",
                   "july","august","september","october","november","december"][mi];
      if (sl === m3 || sl === mFull || sl.slice(0,3) === m3) return MONTH3[mi];
    }
    return s;
  }

  /* Range: BJ:BP  (BJ = col 62, 7 cols)
       BJ(col 62)=Timestamp  BK(col 63)=Hospital  BL(col 64)=Product(s)
       BM(col 65)=Month       BN(col 66)=State     BO(col 67)=Approx Sale   BP(col 68)=RSM

     Logic identical to YTD / monthly sections:
       - Products from BL → split → sort alphabetically → rejoin (normalize)
       - Month from BM (normalised to 3-char: Jul/Aug/Sep)
       - Value from BO (Approx Expecting Sale) — no price lookup / no multiplication
       - forecastData[normalizedProduct][month] = { count: N, value: V }
  */
  var forecastData     = {};   /* { normalizedProduct: { month: { count:N, value:V } } } */
  var priceForecastMap = {};   /* kept for backward compat, not used for value calc */
  try {
    var fcLastRow = rep.getLastRow();
    if (fcLastRow >= 2) {
      /* Read BJ:BP = 7 cols starting at col 62 */
      var fcRows = rep.getRange(2, 62, fcLastRow - 1, 7).getValues();
      fcRows.forEach(function(row) {
        var hospital = String(row[0] || "").trim();  /* BJ = Hospital Name */
        var prodCell = String(row[1] || "").trim();  /* BK = Demo Product ← products here */
        var month    = normMonth(row[3]);             /* BM = Expected Sale Month */
        var boVal    = row[5];                        /* BO = Approx Expecting Sale */

        if (!prodCell || !month) return;

        var amt = typeof boVal === "number" ? boVal
                  : parseFloat(String(boVal || "0").replace(/[^0-9.-]/g, "")) || 0;

        /* Normalize: sort products alphabetically — same as monthly/YTD */
        var normalKey = prodCell.split(",")
          .map(function(p){ return p.trim(); })
          .filter(Boolean)
          .sort()
          .join(", ");

        if (!normalKey) return;

        if (!forecastData[normalKey]) forecastData[normalKey] = {};
        if (!forecastData[normalKey][month]) forecastData[normalKey][month] = { count: 0, value: 0 };
        forecastData[normalKey][month].count++;
        forecastData[normalKey][month].value += amt;
      });
    }
  } catch(eFC) { Logger.log("WARN: forecast failed: " + eFC.message); }

  /* ══════════════════════════════════════════════
     11a. TOTAL PIPELINE (YTD) FROM AK:AP
          Full range: AK:AP  (AK = col 37, 6 cols)
            AK (col 37) = Timestamp
            AL (col 38) = Hospital Name
            AM (col 39) = Demo Product
            AN (col 40) = State
            AO (col 41) = Sales Executive Email → Email/RSM mapping
            AP (col 42) = Approx Expecting Sale  ← sum this

          YTD = rows whose AK timestamp falls in the current
                Indian financial year (1 Apr of this FY to today).

          NOTE: previously skipped rows sharing the same
          Hospital+Product as "duplicates" — removed per request,
          since that was silently dropping genuinely separate
          opportunities (e.g. the same hospital ordering the same
          product again on a different date) and made this total
          not match the raw sheet sum. Every valid FY row is now
          summed, with no de-duplication.
  ══════════════════════════════════════════════ */
  var EMAIL_TO_RSM = {
    "vijay@globalmedicare.co.in"           : "Vijay",
    "amitthakurglobalmedicare@gmail.com"   : "Vijay",
    "shaneshwarglobalmedicare@gmail.com"   : "Vijay",
    "arifaltafglobalmedicare@gmail.com"    : "Vijay",
    "harunglobalmedicare@gmail.com"        : "Vijay",
    "jugaljodhpurglobalmedicare@gmail.com" : "Vijay",
    "rajinderglobalmedicare@gmail.com"     : "Vijay",
    "daya.shanker@globalmedicare.co.in"    : "Daya",
    "muskanglobalmedicare@gmail.com"       : "Daya",
    "ashrafglobalmedicare@gmail.com"       : "Daya",
    "ranjanglobalmedicare@gmail.com"       : "Daya",
    "arungloballko@gmail.com"              : "Daya",
    "pintuglobalmedicare@gmail.com"        : "Daya",
    "pankajglobalmedicare@gmail.com"       : "Daya",
    "giridharanglobalmedicare@gmail.com"   : "Giridharan",
    "giridharan@globalmedicare.co.in"      : "Giridharan",
    "hemchandanglobalmedicare@gmail.com"   : "Giridharan",
    "jeevarathinamglobalmedicare@gmail.com": "Giridharan",
    "arunchennaiglobalmedicare@gmail.com"  : "Giridharan",
    "aravindglobalmedicare@gmail.com"      : "Giridharan",
    "tanmoyglobalmedicare@gmail.com"       : "Tanmoy",
    "sudiptaglobalmedicare@gmail.com"      : "Tanmoy",
    "dibakarglobalmedicare@gmail.com"      : "Tanmoy",
    "rohitglobalmedicare@gmail.com"        : "Tanmoy",
    "abhishek@globalmedicare.co.in"        : "Abhishek Tiwari",
    "tiwariabhi1001@gmail.com"             : "Abhishek Tiwari",
    "akashglobalmedicare@gmail.com"        : "Abhishek Tiwari",
    "tausifglobalmedicare@gmail.com"       : "Abhishek Tiwari",
    "tkamlesh2018@gmail.com"               : "Abhishek Tiwari",
    "gauravb.globalmedicare@gmail.com"     : "Abhishek Tiwari"
  };

  var rsmYtdPipeline = {};
  RSM_NAMES.forEach(function(n) { rsmYtdPipeline[n] = 0; });
  var totalPipelineYtd = 0;

  try {
    var apLastRow = rep.getLastRow();
    if (apLastRow >= 2) {
      /* Determine current Indian Financial Year start (1 Apr) */
      var today  = new Date();
      var fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
      var fyStart = new Date(fyYear, 3, 1);  /* 1 April of current FY */

      /* Read full AK:AP block — AK=col37, 6 cols */
      var apRows = rep.getRange(2, 37, apLastRow - 1, 6).getValues();

      apRows.forEach(function(row) {
        var ts       = row[0];                                      /* AK: Timestamp */
        var hospital = String(row[1] || "").trim();                 /* AL: Hospital  */
        var product  = String(row[2] || "").trim();                 /* AM: Product   */
        var email    = String(row[4] || "").trim().toLowerCase();   /* AO: Email     */
        var rawVal   = row[5];                                      /* AP: Value     */

        if (!rawVal && rawVal !== 0) return;
        var valStr = String(rawVal).replace(/[₹,\s]/g, "").trim();
        var value  = parseFloat(valStr) || 0;
        if (value <= 0) return;

        /* YTD filter: timestamp must be within the current financial year */
        var d = parseSheetTimestamp(ts);
        if (!d || d < fyStart || d > today) return;

        /* No de-duplication — every valid FY row counts, so this
           total always matches the raw sheet sum. */
        totalPipelineYtd += value;

        /* RSM split (unchanged) */
        var rsm = EMAIL_TO_RSM[email] || EMAIL_TO_RSM[email.toLowerCase()] || null;
        if (rsm) rsmYtdPipeline[rsm] = (rsmYtdPipeline[rsm] || 0) + value;
      });
    }
    Logger.log("totalPipelineYtd: " + totalPipelineYtd);
  } catch(eAP) { Logger.log("WARN: rsmYtdPipeline AO:AP failed: " + eAP.message); }

  /* ══════════════════════════════════════════════
     11. LAST 6 MONTH DEMO TREND — delegated to computeDemoTrend()
  ══════════════════════════════════════════════ */
  var demoTrend = computeDemoTrend();
  delete demoTrend._rowCount; /* remove debug fields before sending to frontend */
  delete demoTrend._debug;

  /* ══════════════════════════════════════════════
     11b. RSM WISE 3-MONTH EXPECTED SALE  Report!BJ:BP
            BM (col 65) = Month, BO (col 67) = Value, BP (col 68) = RSM Name
            Using for-loops only — safe on all GAS runtimes.
  ══════════════════════════════════════════════ */
  var rsmMonthPipeline = {};
  for (var rn = 0; rn < RSM_NAMES.length; rn++) {
    rsmMonthPipeline[RSM_NAMES[rn]] = {};
  }
  try {
    var bR = rep.getRange(2, 62, rep.getLastRow() - 1, 7).getValues();
    var bHits = 0, bMiss = 0;
    for (var bi = 0; bi < bR.length; bi++) {
      var bBm  = normMonth(bR[bi][3]);           /* BM col65 - Expected Sale Month */
      var bBo  = bR[bi][5];                       /* BO col67 - Approx Sale Value */
      var bBp  = String(bR[bi][6] || "").trim();  /* BP col68 - RSM Name directly */
      if (!bBm || !bBp) continue;
      /* Resolve RSM: exact match on BP against RSM_NAMES */
      var bRsm = null;
      var bBpL = bBp.toLowerCase();
      for (var bRi = 0; bRi < RSM_NAMES.length; bRi++) {
        if (RSM_NAMES[bRi] === bBp || RSM_NAMES[bRi].toLowerCase() === bBpL) {
          bRsm = RSM_NAMES[bRi]; break;
        }
      }
      if (!bRsm) { bMiss++; continue; }
      bHits++;
      var bAmt = (typeof bBo === "number") ? Math.abs(bBo)
                 : Math.abs(parseFloat(String(bBo || "0").replace(/[^0-9.]/g, "")) || 0);
      if (bAmt <= 0) continue;
      if (!rsmMonthPipeline[bRsm]) rsmMonthPipeline[bRsm] = {};
      rsmMonthPipeline[bRsm][bBm] = (rsmMonthPipeline[bRsm][bBm] || 0) + bAmt;
    }
    Logger.log("rsmPipeline hits=" + bHits + " misses=" + bMiss +
               " result=" + JSON.stringify(rsmMonthPipeline));
  } catch(eRMP) { Logger.log("WARN rsmMonthPipeline: " + eRMP.message); }

  /* ══════════════════════════════════════════════════
     Extra top-level KPI values for the main dashboard cards:
     Current Bank Balance, Expected Payment Receive (This
     Month), Overdue Invoices (Over 6 Months). These reuse the
     EXACT SAME Accounts-section functions already in this file
     (getCurrentBankData/getMonthlyPayments/getOverdue6PlusMonths)
     — no new sheet ranges, no duplicated logic — just surfaced
     here too so the main KPI row has them without requiring the
     Accounts section to be opened first.
  ══════════════════════════════════════════════ */
  var currentBankForKpi = getCurrentBankData();

  var monthlyPaymentsForKpi = getMonthlyPayments();
  var expectedPaymentThisMonthTotal = (monthlyPaymentsForKpi.rows || [])
    .reduce(function(s, r) { return s + (Number(r.amount) || 0); }, 0);

  var overdue6PlusForKpi = getOverdue6PlusMonths();
  var overdueSixPlusTotal = (overdue6PlusForKpi.rows || [])
    .reduce(function(s, r) { return s + (Number(r.amount) || 0); }, 0);

  var result = {
    generatedAt    : new Date().toISOString(),
    fromCache      : false,
    rsms           : RSM_NAMES.map(function(n) { return rsms[n]; }),
    leads          : leadsMap,
    products       : products,
    priceMap       : priceMap,
    prodCustMap    : prodCustMap,
    productsYtd      : productsYtd,
    priceMapYtd      : priceMapYtd,
    prodCustMapYtd   : prodCustMapYtd,
    forecastData     : forecastData,
    priceForecastMap : priceForecastMap,
    demoTrend        : demoTrend,
    rsmYtdPipeline    : rsmYtdPipeline,
    totalPipelineYtd  : totalPipelineYtd,
    rsmMonthPipeline : rsmMonthPipeline,
    thisMonthSale    : getThisMonthSale(),
    totalSaleYtdTotal: getTotalSaleYtdRows().total,
    currentBankAmount              : currentBankForKpi.amount,
    expectedPaymentThisMonthTotal  : Math.round(expectedPaymentThisMonthTotal),
    overdueSixPlusTotal            : Math.round(overdueSixPlusTotal),
    execList         : SALES_EXECUTIVES,
    rsmHierarchyOrder: RSM_HIERARCHY_ORDER,
    salesExecReportsByRsm: getSalesExecutiveReports().byRsm,
    meta : {
      scorecard        : "Report!A2:F6",
      demo             : "Report!P1:R6",
      unique           : "Report!AR1:AT6",
      funnel           : "Report!H1:N5",
      leads            : "Report!AD2:AI",
      prices           : "Report!AZ:BA (AZ=Product BA=Price)",
      customers        : "Report!AW:AY (AW=Hospital AX=Product AY=State)",
      pricesYtd        : "Report!BG:BH (BG=Product BH=Price)",
      customersYtd     : "Report!BD:BF (BD=Hospital BE=Product BF=State)",
      forecast         : "Report!BJ:BM + Report!BN:BO",
      demoTrend        : "Report!T:W (T=Timestamp W=RSM) → YYYY-MM month keys",
      rsmMonthPipeline : "Report!BJ:BP → RSM+month sums",
      executiveDetail  : "Report!BR:BW (BR=Timestamp BS=Email BT=Hospital BU=City BV=Product BW=RSM)",
      wantsDemo        : "Report!BY:CD (BY=Timestamp BZ=Email CA=Hospital CB=City CC=Product CD=RSM)",
      demoDonePending  : "Report!CF:CK (CF=Timestamp CG=Email CH=Hospital CI=City CJ=Product CK=RSM)",
      quotationSubmitted: "Report!CM:CR (CM=Timestamp CN=Email CO=Hospital CP=City CQ=Product CR=RSM)"
    }
  };

  try { cache.put(CACHE_KEY, JSON.stringify(result), CACHE_SECONDS); }
  catch (e) { Logger.log("Cache put failed: " + e.message); }

  return result;
}

/* ── Utilities ── */
function refreshCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
  CacheService.getScriptCache().remove(TVA_CACHE_KEY);
  return { cleared: true };
}
function dashboardHealth() {
  return { status: "OK", time: new Date().toISOString(),
           sheet: SpreadsheetApp.getActiveSpreadsheet().getName() };
}
function testDashboard() {
  Logger.log(JSON.stringify(getDashboardData(true), null, 2));
}

/* ═══════════════════════════════════════════════
   testBothSections()
   Run DIRECTLY in Apps Script editor (no deployment needed).
   Reads T:W and BJ:BP and shows exactly what the code sees.
   Share the full Execution Log output.
═══════════════════════════════════════════════ */
function testBothSections() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("ERROR: Sheet '" + REPORT_TAB + "' not found"); return; }

  var last = rep.getLastRow();
  Logger.log("Sheet last row: " + last);

  /* ── 1. Demo Trend: T:W (cols 20-23) ── */
  Logger.log("\n=== DEMO TREND (T:W) first 10 data rows ===");
  var tw = rep.getRange(2, 20, Math.min(last-1, 10), 4).getValues();
  tw.forEach(function(r, i) {
    Logger.log("Row " + (i+2) + ": T=[" + r[0] + "] U=[" + r[1] + "] V=[" + r[2] + "] W=[" + r[3] + "]");
  });

  Logger.log("\n--- Demo Trend aggregation result ---");
  var demoResult = {};
  tw.forEach(function(r) {
    var ts = r[0]; var wRaw = String(r[3] || "").trim();
    if (!wRaw || !ts) return;
    var d = parseSheetTimestamp(ts);
    if (!d) return;
    var key = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
    if (!demoResult[wRaw]) demoResult[wRaw] = {};
    demoResult[wRaw][key] = (demoResult[wRaw][key]||0) + 1;
  });
  Logger.log("demoResult: " + JSON.stringify(demoResult));

  /* ── 2. RSM Pipeline: BJ:BP (cols 62-68) ── */
  Logger.log("\n=== RSM PIPELINE (BJ:BP) first 10 data rows ===");
  var bj = rep.getRange(2, 62, Math.min(last-1, 10), 7).getValues();
  bj.forEach(function(r, i) {
    Logger.log("Row " + (i+2) +
      ": BJ=[" + String(r[0]).slice(0,18) + "]" +
      " BK=[" + String(r[1]).slice(0,15) + "]" +
      " BL=[" + String(r[2]).slice(0,12) + "]" +
      " BM=[" + r[3] + "]" +
      " BN=[" + String(r[4]).slice(0,20) + "]" +
      " BO=[" + r[5] + "]" +
      " BP=[" + r[6] + "]");
  });

  Logger.log("\n--- RSM Pipeline aggregation result ---");
  var rsmResult = {};
  bj.forEach(function(r) {
    var bm = String(r[3]||"").trim();
    var bo = r[5];
    var bp = String(r[6]||"").trim();
    var amt = typeof bo === "number" ? Math.abs(bo)
              : Math.abs(parseFloat(String(bo||"0").replace(/[^0-9.-]/g,""))||0);
    Logger.log("  BM=" + bm + " BP=" + bp + " BO(parsed)=" + amt);
    if (!bm || !bp || amt<=0) return;
    if (!rsmResult[bp]) rsmResult[bp] = {};
    rsmResult[bp][bm] = (rsmResult[bp][bm]||0) + amt;
  });
  Logger.log("rsmResult: " + JSON.stringify(rsmResult));
}


/* ══ Run these directly in Apps Script editor to find the issue ══ */

function debugDemoTrend() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  var last = rep.getLastRow();
  Logger.log("Last row: " + last);

  /* Show first 15 rows of T:W (cols 20-23) */
  var rows = rep.getRange(1, 20, Math.min(last, 16), 4).getValues();
  Logger.log("=== T:W header + first 15 rows ===");
  rows.forEach(function(r, i) {
    Logger.log("Row " + (i+1) + ": T=[" + r[0] + "] U=[" + r[1] + "] V=[" + r[2] + "] W=[" + r[3] + "]");
  });
}

function debugRsmPipeline() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  var last = rep.getLastRow();

  /* Show first 15 rows of BJ:BP (cols 62-68) */
  var rows = rep.getRange(1, 62, Math.min(last, 16), 7).getValues();
  Logger.log("=== BJ:BP header + first 15 rows ===");
  rows.forEach(function(r, i) {
    Logger.log("Row " + (i+1) + ": BJ=[" + r[0] + "] BK=[" + r[1] + "] BL=[" + r[2] +
               "] BM=[" + r[3] + "] BN=[" + r[4] + "] BO=[" + r[5] + "] BP=[" + r[6] + "]");
  });

  /* Check which emails match EMAIL_TO_RSM or SALES_EXECUTIVES */
  Logger.log("=== BN email → RSM mapping check (first 20 data rows) ===");
  var dataRows = rep.getRange(2, 62, Math.min(last - 1, 20), 7).getValues();
  dataRows.forEach(function(r, i) {
    var email = String(r[4] || "").trim().toLowerCase();
    var rsmDirect = EMAIL_TO_RSM[email];
    var execMatch = SALES_EXECUTIVES.find(function(e){ return e.email.toLowerCase() === email; });
    Logger.log("Row " + (i+2) + ": BN=[" + email + "] → direct=" + (rsmDirect||"NOT FOUND") +
               " | execRSM=" + (execMatch ? execMatch.rsm : "NOT FOUND") +
               " | BM=[" + r[3] + "] | BO=[" + r[5] + "]");
  });
}


/* ══════════════════════════════════════════════════
   testYtdPrices()
   Run DIRECTLY in Apps Script editor (Run → testYtdPrices).
   Shows:
   1. Everything in BG:BH (product names + prices)
   2. Unique product names from BE column
   3. Which ones match and which ones fail
   This tells us exactly why price = ₹0.
══════════════════════════════════════════════════ */
function testYtdPrices() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet not found: " + REPORT_TAB); return; }

  var lastRow = rep.getLastRow();

  /* 1. Read BG:BH — log every row including type info */
  Logger.log("=== BG:BH (cols 59-60) ALL rows ===");
  var bgRows = rep.getRange(2, 59, Math.max(lastRow - 1, 1), 2).getValues();
  var priceMap = {};
  var priceCount = 0;
  bgRows.forEach(function(r, i) {
    var prod  = String(r[0] || "").trim();
    var raw   = r[1];
    if (!prod && !raw) return;                    /* skip fully blank rows */
    var price = typeof raw === "number" ? Math.abs(raw)
                : parseFloat(String(raw || "0").replace(/[^0-9.-]/g, "")) || 0;
    Logger.log("Row " + (i + 2) + ": BG='" + prod + "' (type:" + typeof r[0] +
               ") | BH_raw='" + raw + "' (type:" + typeof raw + ") | parsed=" + price);
    if (prod && price > 0) { priceMap[prod.toLowerCase()] = price; priceCount++; }
  });
  Logger.log("Price map built: " + priceCount + " entries → " + Object.keys(priceMap).join(", "));

  /* 2. Read BE — get unique individual product names */
  Logger.log("=== BE (col 57) unique individual products ===");
  var beRows = rep.getRange(2, 57, lastRow - 1, 1).getValues();
  var uniqueProds = {};
  beRows.forEach(function(r) {
    var cell = String(r[0] || "").trim();
    cell.split(",").forEach(function(p) {
      p = p.trim();
      if (p) uniqueProds[p] = true;
    });
  });
  Object.keys(uniqueProds).sort().forEach(function(p) {
    var matched = priceMap[p.toLowerCase()];
    Logger.log("BE product: '" + p + "' → price=" + (matched || "NOT FOUND IN BG:BH ❌"));
  });
}


/* ══════════════════════════════════════════════════
   testProducts()
   Run this DIRECTLY in the Apps Script editor
   (Run → testProducts) — no deployment needed.
   Shows exactly what each product sums to from AV:BA.
   Helps debug why total differs from expected.
══════════════════════════════════════════════════ */
function testProducts() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet not found: " + REPORT_TAB); return; }

  var lastRow = rep.getLastRow();
  Logger.log("Last row: " + lastRow);

  /* Read AV:BA = cols 48-53 */
  var rows = rep.getRange(2, 48, lastRow - 1, 6).getValues();
  Logger.log("Total rows read from AV:BA: " + rows.length);

  var map = {};
  var rowsWithValue = 0;
  var rowsSkipped   = 0;

  rows.forEach(function(r, i) {
    var hospital = String(r[1] || "").trim();  /* AW */
    var prod     = String(r[2] || "").trim();  /* AX */
    var ba       = r[5];                       /* BA */
    var amt      = typeof ba === "number" ? ba : parseFloat(String(ba || "0").replace(/[^0-9.-]/g, "")) || 0;

    if (!prod || amt <= 0) { rowsSkipped++; return; }
    rowsWithValue++;
    if (!map[prod]) map[prod] = 0;
    map[prod] += amt;
  });

  Logger.log("Rows with valid product+value: " + rowsWithValue);
  Logger.log("Rows skipped (blank prod or zero BA): " + rowsSkipped);
  Logger.log("=== PRODUCT SUMS ===");

  var grand = 0;
  Object.keys(map).sort(function(a,b){return map[b]-map[a];}).forEach(function(p) {
    Logger.log(p + " → ₹" + map[p].toLocaleString());
    grand += map[p];
  });
  Logger.log("GRAND TOTAL (all products) → ₹" + grand.toLocaleString() + " = ₹" + (grand/10000000).toFixed(2) + " Cr");
}

function testExecutiveData() {
  Logger.log(JSON.stringify(getExecutiveDashboardData(SALES_EXECUTIVES[0].email), null, 2));
}
function testWantsDemo() {
  Logger.log(JSON.stringify(getWantsDemoData(), null, 2));
}
function testDemoDonePending() {
  Logger.log(JSON.stringify(getDemoDoneData(), null, 2));
}
function testQuotationSubmitted() {
  Logger.log(JSON.stringify(getQuotationSubmittedData(), null, 2));
}
function debugQuotationSubmittedColumns() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet not found"); return; }
  var lastRow = Math.min(rep.getLastRow(), 12);
  Logger.log("=== CM:CR rows 1-" + lastRow + " ===");
  var data = rep.getRange(1, 91, lastRow, 6).getValues();
  data.forEach(function(row, ri) {
    Logger.log("Row " + (ri+1) + ": " +
      ["CM","CN","CO","CP","CQ","CR"].map(function(c,i){
        return c + "=[" + String(row[i]).slice(0,22) + "]";
      }).join(" | "));
  });
}
function testSalesExecutiveReports() {
  Logger.log(JSON.stringify(getSalesExecutiveReports(), null, 2));
}
function debugDemoDoneColumns() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet not found"); return; }
  var lastRow = Math.min(rep.getLastRow(), 12);
  Logger.log("=== CF:CK rows 1-" + lastRow + " ===");
  var data = rep.getRange(1, 84, lastRow, 6).getValues();
  data.forEach(function(row, ri) {
    Logger.log("Row " + (ri+1) + ": " +
      ["CF","CG","CH","CI","CJ","CK"].map(function(c,i){
        return c + "=[" + String(row[i]).slice(0,22) + "]";
      }).join(" | "));
  });
}
function debugWantsDemoColumns() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet not found"); return; }
  var lastRow = Math.min(rep.getLastRow(), 12);
  Logger.log("=== BY:CD rows 1-" + lastRow + " ===");
  var data = rep.getRange(1, 77, lastRow, 6).getValues();
  data.forEach(function(row, ri) {
    Logger.log("Row " + (ri+1) + ": " +
      ["BY","BZ","CA","CB","CC","CD"].map(function(c,i){
        return c + "=[" + String(row[i]).slice(0,22) + "]";
      }).join(" | "));
  });
}
function debugExecColumns() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet not found"); return; }
  var lastRow = Math.min(rep.getLastRow(), 12);
  Logger.log("=== BR:BW rows 1-" + lastRow + " ===");
  var data = rep.getRange(1, 70, lastRow, 6).getValues();
  data.forEach(function(row, ri) {
    Logger.log("Row " + (ri+1) + ": " +
      ["BR","BS","BT","BU","BV","BW"].map(function(c,i){
        return c + "=[" + String(row[i]).slice(0,22) + "]";
      }).join(" | "));
  });
}

/* ══════════════════════════════════════════════════
   debugInventoryColumns()
   Run DIRECTLY in the Apps Script editor (Run → debugInventoryColumns),
   no deployment needed. Dumps Report!DY:EA (first ~40 rows) along
   with the DY cell's font weight, font color, and background color
   for each row — this tells us EXACTLY what visual signal marks a
   "company header" row vs an "item" row, instead of guessing.

   Share the full Execution Log output (View → Logs, or Ctrl+Enter)
   so getInventoryItemWise() can be fixed to use the real signal.
══════════════════════════════════════════════════ */
function debugInventoryColumns() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var rep = ss.getSheetByName(REPORT_TAB);
  if (!rep) { Logger.log("Sheet '" + REPORT_TAB + "' not found"); return; }

  var lastRow = rep.getLastRow();
  Logger.log("Report sheet last row: " + lastRow);
  if (lastRow < 2) { Logger.log("No data rows (last<2)"); return; }

  var numRows = Math.min(lastRow - 1, 40);
  var range   = rep.getRange(2, 129, numRows, 3); /* DY=129, 3 cols DY:EA */
  var values      = range.getValues();
  var fontWeights = range.getFontWeights();
  var fontColors  = range.getFontColors();
  var backgrounds = range.getBackgrounds();

  Logger.log("=== Report!DY:EA rows 2-" + (numRows + 1) + " (value / fontWeight / fontColor / background) ===");
  for (var i = 0; i < values.length; i++) {
    var dy = String(values[i][0] || "");
    var dz = values[i][1];
    var ea = values[i][2];
    if (!dy.trim() && !dz && !ea) {
      Logger.log("Row " + (i + 2) + ": (blank)");
      continue;
    }
    Logger.log(
      "Row " + (i + 2) +
      ": DY=[" + dy + "]" +
      " DZ=[" + dz + "]" +
      " EA=[" + ea + "]" +
      " | fontWeight=" + fontWeights[i][0] +
      " | fontColor=" + fontColors[i][0] +
      " | background=" + backgrounds[i][0]
    );
  }
}


/* ══════════════════════════════════════════════════════════════════════
   DAILY EXPECTED-PAYMENT PDF EMAIL AUTOMATION
   ----------------------------------------------------------------------
   Purpose: Every morning (9–10 AM window via a time-driven trigger),
   e-mail two PDF reports — one for Kamaljeet, one for Varsha — built
   from the SAME live data that powers the dashboard's
   "Expected Payment Receive This Week" table.

   Data source: reuses getWeeklyPayments() (Report!DP:DW, current
   Mon→Sat week, filtered by Expected Payment Date). Nothing hardcoded —
   the current week is recomputed on every run.

   This block is fully self-contained. It does NOT touch the dashboard
   UI, the Accounts section, or any existing function. To activate the
   daily schedule, run installDailyExpectedPaymentTrigger() ONCE.
   ══════════════════════════════════════════════════════════════════════ */

var EXPECTED_PAYMENT_REPORT_RECIPIENT = "info@globalmedicare.co.in";

/* One-time setup — run this ONCE from the Apps Script editor.
   Creates time-driven triggers that fire MONDAY through SATURDAY
   (Sunday skipped), each in the 9–10 AM window (Apps Script cannot
   guarantee the exact minute). Safe to re-run: it removes any existing
   trigger for this handler first so you never end up with duplicates. */
function installDailyExpectedPaymentTrigger() {
  var HANDLER = "sendDailyExpectedPaymentReport";

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER) ScriptApp.deleteTrigger(t);
  });

  var days = [
    ScriptApp.WeekDay.MONDAY,
    ScriptApp.WeekDay.TUESDAY,
    ScriptApp.WeekDay.WEDNESDAY,
    ScriptApp.WeekDay.THURSDAY,
    ScriptApp.WeekDay.FRIDAY,
    ScriptApp.WeekDay.SATURDAY
  ];

  days.forEach(function (d) {
    ScriptApp.newTrigger(HANDLER)
      .timeBased()
      .onWeekDay(d)
      .atHour(9)          // 9–10 AM window
      .create();
  });

  Logger.log("Trigger installed for " + HANDLER + " — fires Mon–Sat, 9–10 AM (Sunday skipped).");
}

/* Optional helper — removes the daily trigger if you ever want to stop
   the automated emails. */
function removeDailyExpectedPaymentTrigger() {
  var HANDLER = "sendDailyExpectedPaymentReport";
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER) { ScriptApp.deleteTrigger(t); removed++; }
  });
  Logger.log("Removed " + removed + " trigger(s) for " + HANDLER + ".");
}

/* Main entry point — called by the daily trigger (or run manually to
   test). Fetches the live weekly data, splits it by person, builds two
   PDFs, and emails both as attachments in a single message. */
function sendDailyExpectedPaymentReport() {
  var payload = getWeeklyPayments();            // live, reused source
  var rows    = (payload && payload.rows) ? payload.rows : [];
  var weekStart = payload ? payload.weekStart : "";
  var weekEnd   = payload ? payload.weekEnd   : "";

  // Split by the VARSHA / KAMALJEET column (row.person). Matching is
  // case-insensitive and tolerant of extra spaces.
  var kamaljeetRows = rows.filter(function (r) { return _matchesPerson(r.person, "Kamaljeet"); });
  var varshaRows    = rows.filter(function (r) { return _matchesPerson(r.person, "Varsha"); });

  var kamaljeetPdf = _buildExpectedPaymentPdf("Kamaljeet", kamaljeetRows, weekStart, weekEnd)
    .setName("Expected_Payment_This_Week_Kamaljeet.pdf");
  var varshaPdf = _buildExpectedPaymentPdf("Varsha", varshaRows, weekStart, weekEnd)
    .setName("Expected_Payment_This_Week_Varsha.pdf");

  MailApp.sendEmail({
    to:      EXPECTED_PAYMENT_REPORT_RECIPIENT,
    subject: "Expected Payment Receive This Week — Daily Report",
    body:    "Please find attached the daily Expected Payment Receive This Week reports for Kamaljeet and Varsha.",
    attachments: [kamaljeetPdf, varshaPdf]
  });

  Logger.log("Daily Expected Payment report sent to " + EXPECTED_PAYMENT_REPORT_RECIPIENT +
             " (Kamaljeet: " + kamaljeetRows.length + " rows, Varsha: " + varshaRows.length + " rows).");
}

/* Case-insensitive, space-tolerant person match. */
function _matchesPerson(value, name) {
  return String(value || "").trim().toLowerCase() === String(name).trim().toLowerCase();
}

/* Indian-format currency, e.g. 3583870 -> "₹35,83,870". Mirrors the
   dashboard's fmtRupee() behaviour (en-IN grouping, no decimals). */
function _fmtRupeeServer(n) {
  n = Number(n) || 0;
  var neg = n < 0;
  n = Math.round(Math.abs(n)).toString();
  var last3 = n.length > 3 ? n.slice(-3) : n;
  var other = n.length > 3 ? n.slice(0, -3) : "";
  if (other) last3 = "," + last3;
  other = other.replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return "₹" + (neg ? "-" : "") + other + last3;
}

/* dd MMM yyyy, or "—" when missing/invalid. */
function _fmtDateServer(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  var tz = Session.getScriptTimeZone() || "Asia/Kolkata";
  return Utilities.formatDate(d, tz, "dd MMM yyyy");
}

/* HTML-escape helper for safe cell content. */
function _esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* Builds a single person's PDF blob. Uses an HTML → PDF conversion so
   the table keeps a clean, professional look close to the dashboard. */
function _buildExpectedPaymentPdf(personName, rows, weekStartIso, weekEndIso) {
  var tz = Session.getScriptTimeZone() || "Asia/Kolkata";
  var generatedOn = Utilities.formatDate(new Date(), tz, "dd MMM yyyy, hh:mm a");
  var weekLabel = (weekStartIso && weekEndIso)
    ? (_fmtDateServer(weekStartIso) + " – " + _fmtDateServer(weekEndIso))
    : "Current week";

  var totalAmount = rows.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);

  var bodyRows = rows.map(function (r) {
    return '<tr>' +
      '<td>' + _esc(_fmtDateServer(r.billDate)) + '</td>' +
      '<td class="name">' + _esc(r.customer || "—") + '</td>' +
      '<td>' + _esc(r.state || "—") + '</td>' +
      '<td>' + _esc(r.model || "—") + '</td>' +
      '<td class="num">' + _esc(r.qty || 0) + '</td>' +
      '<td class="amt">' + _esc(_fmtRupeeServer(r.amount)) + '</td>' +
      '<td>' + _esc(r.person || "—") + '</td>' +
    '</tr>';
  }).join("");

  if (!rows.length) {
    bodyRows = '<tr><td colspan="7" class="empty">No payments expected this week for ' +
      _esc(personName) + '.</td></tr>';
  }

  var html =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  '  * { box-sizing: border-box; }' +
  '  body { font-family: Arial, Helvetica, sans-serif; color: #1e293b; margin: 28px; }' +
  '  .hdr { border-bottom: 3px solid #2c7be5; padding-bottom: 12px; margin-bottom: 18px; }' +
  '  .company { font-size: 18px; font-weight: 700; color: #0f172a; }' +
  '  .title { font-size: 15px; font-weight: 600; color: #2c7be5; margin-top: 4px; }' +
  '  .meta { font-size: 11px; color: #64748b; margin-top: 6px; line-height: 1.5; }' +
  '  .meta b { color: #334155; }' +
  '  table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 11px; }' +
  '  thead th { background: #2c7be5; color: #fff; text-align: left; padding: 8px 9px; font-size: 10.5px; ' +
  '             text-transform: uppercase; letter-spacing: .3px; }' +
  '  tbody td { padding: 7px 9px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }' +
  '  tbody tr:nth-child(even) td { background: #f8fafc; }' +
  '  td.name { font-weight: 600; }' +
  '  td.num { text-align: right; }' +
  '  td.amt { text-align: right; font-weight: 700; color: #2c7be5; white-space: nowrap; }' +
  '  td.empty { text-align: center; color: #64748b; padding: 22px 0; font-style: italic; }' +
  '  tfoot td { padding: 9px; font-weight: 700; border-top: 2px solid #2c7be5; }' +
  '  tfoot .amt { text-align: right; color: #2c7be5; white-space: nowrap; }' +
  '  .footnote { margin-top: 16px; font-size: 9.5px; color: #94a3b8; }' +
  '</style></head><body>' +
  '  <div class="hdr">' +
  '    <div class="company">Global Medicare</div>' +
  '    <div class="title">Expected Payment Receive This Week — ' + _esc(personName) + '</div>' +
  '    <div class="meta">' +
  '      <b>Week:</b> ' + _esc(weekLabel) + '<br>' +
  '      <b>Generated:</b> ' + _esc(generatedOn) +
  '    </div>' +
  '  </div>' +
  '  <table>' +
  '    <thead><tr>' +
  '      <th>Bill Date</th><th>Customer Name</th><th>State</th><th>Model</th>' +
  '      <th style="text-align:right">Qty</th><th style="text-align:right">Amount</th>' +
  '      <th>Varsha / Kamaljeet</th>' +
  '    </tr></thead>' +
  '    <tbody>' + bodyRows + '</tbody>' +
  (rows.length ?
  '    <tfoot><tr>' +
  '      <td colspan="5">Total</td>' +
  '      <td class="amt">' + _esc(_fmtRupeeServer(totalAmount)) + '</td>' +
  '      <td></td>' +
  '    </tr></tfoot>' : '') +
  '  </table>' +
  '  <div class="footnote">Auto-generated from the Global Medicare dashboard · Source: Report!DP:DW (filtered by Expected Payment Date).</div>' +
  '</body></html>';

  var htmlBlob = Utilities.newBlob(html, "text/html", "report.html");
  return htmlBlob.getAs("application/pdf");
}
