// ============================================================
// Mock Google Apps Script (GAS) runtime + loader for unit tests.
//
// loadGas(filePaths, options) reads each GAS source file, CONCATENATES
// them into a single string, and runs that one string inside a Node `vm`
// context whose sandbox carries all the mocked GAS globals below.
//
// Concatenating + a single vm.runInContext run is REQUIRED: `const`
// globals like TZ / CONFIG declared in webhook.js must live in the same
// script scope that billing.js's functions close over. Function
// declarations (function foo(){}) become properties of the sandbox, so
// the returned ctx exposes them, e.g. ctx.buildBillingSummary_.
// ============================================================

const fs = require("fs");
const vm = require("vm");

// ------------------------------------------------------------
// Utilities.formatDate / parseDate helpers
// ------------------------------------------------------------

// Extract date parts for a given IANA time zone using Intl.
function tzParts(date, tz) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // Intl can emit "24" for midnight hour in some environments; normalize.
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

function formatDate(date, tz, fmt) {
  const p = tzParts(date, tz);
  const hourNoPad = String(Number(p.hour)); // single H (no pad)
  // Replace longest tokens first so e.g. yyyy beats nothing and HH beats H.
  return String(fmt)
    .replace(/yyyy/g, p.year)
    .replace(/MM/g, p.month)
    .replace(/dd/g, p.day)
    .replace(/HH/g, p.hour)
    .replace(/mm/g, p.minute)
    .replace(/ss/g, p.second)
    .replace(/H/g, hourNoPad);
}

function parseDate(str, _tz, fmt) {
  const s = String(str ?? "").trim();
  // Enough to parse "yyyy-MM-dd".
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  const d = new Date(s);
  return d;
}

// ------------------------------------------------------------
// Mock Sheet / Spreadsheet
// ------------------------------------------------------------

const isEmptyCell = (v) => v === "" || v === null || v === undefined;

class MockSheet {
  constructor(name) {
    this._name = name;
    this.cells = []; // array of row arrays (0-based internally, 1-based API)
    this._frozenRows = 0;
  }

  getName() {
    return this._name;
  }

  _ensureRow(r0) {
    while (this.cells.length <= r0) this.cells.push([]);
  }

  _ensureCell(r0, c0) {
    this._ensureRow(r0);
    const row = this.cells[r0];
    while (row.length <= c0) row.push("");
  }

  getRange(row, col, numRows = 1, numCols = 1) {
    // Real GAS throws on a zero/negative-sized range; mirror that so tests
    // catch any reader that drops its getLastRow() >= 2 guard.
    if (numRows < 1 || numCols < 1) {
      throw new Error("The number of rows in the range must be at least 1.");
    }
    const sheet = this;
    const r0 = row - 1;
    const c0 = col - 1;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < numRows; i++) {
          const rowOut = [];
          const srcRow = sheet.cells[r0 + i] || [];
          for (let j = 0; j < numCols; j++) {
            const v = srcRow[c0 + j];
            rowOut.push(isEmptyCell(v) ? "" : v);
          }
          out.push(rowOut);
        }
        return out;
      },
      setValues(vals) {
        for (let i = 0; i < vals.length; i++) {
          const srcRow = vals[i] || [];
          for (let j = 0; j < srcRow.length; j++) {
            sheet._ensureCell(r0 + i, c0 + j);
            sheet.cells[r0 + i][c0 + j] = srcRow[j];
          }
        }
        return this;
      },
      setValue(v) {
        sheet._ensureCell(r0, c0);
        sheet.cells[r0][c0] = v;
        return this;
      },
      setFormula(f) {
        sheet._ensureCell(r0, c0);
        sheet.cells[r0][c0] = f; // store the formula text so tests can inspect it
        return this;
      },
      clearContent() {
        for (let i = 0; i < numRows; i++) {
          if (!sheet.cells[r0 + i]) continue;
          for (let j = 0; j < numCols; j++) {
            if (c0 + j < sheet.cells[r0 + i].length) {
              sheet.cells[r0 + i][c0 + j] = "";
            }
          }
        }
        return this;
      },
    };
  }

  getLastRow() {
    let last = 0;
    for (let r = 0; r < this.cells.length; r++) {
      const row = this.cells[r] || [];
      if (row.some((v) => !isEmptyCell(v))) last = r + 1;
    }
    return last;
  }

  getLastColumn() {
    let last = 0;
    for (let r = 0; r < this.cells.length; r++) {
      const row = this.cells[r] || [];
      for (let c = 0; c < row.length; c++) {
        if (!isEmptyCell(row[c])) last = Math.max(last, c + 1);
      }
    }
    return last;
  }

  appendRow(arr) {
    this.cells.push(Array.isArray(arr) ? arr.slice() : [arr]);
    return this;
  }

  setFrozenRows(n) {
    this._frozenRows = n;
    return this;
  }

  deleteRow(r) {
    if (r >= 1 && r <= this.cells.length) this.cells.splice(r - 1, 1);
    return this;
  }

  deleteRows(r, n) {
    if (r >= 1) this.cells.splice(r - 1, n);
    return this;
  }
}

class MockSpreadsheet {
  constructor() {
    this._sheets = [];
  }

  getSheetByName(name) {
    return this._sheets.find((s) => s.getName() === name) || null;
  }

  insertSheet(name) {
    let s = this.getSheetByName(name);
    if (s) return s;
    s = new MockSheet(name);
    this._sheets.push(s);
    return s;
  }

  getSheets() {
    return this._sheets.slice();
  }

  // ---- test helpers ----
  __seed(name, rows2D) {
    let s = this.getSheetByName(name);
    if (!s) s = this.insertSheet(name);
    s.cells = (rows2D || []).map((r) => (Array.isArray(r) ? r.slice() : [r]));
    return s;
  }

  __data(name) {
    const s = this.getSheetByName(name);
    if (!s) return null;
    return s.cells.map((r) => r.slice());
  }
}

// ------------------------------------------------------------
// Chainable menu / trigger stubs
// ------------------------------------------------------------

function makeMenuStub() {
  const stub = {};
  stub.addItem = () => stub;
  stub.addSeparator = () => stub;
  stub.addSubMenu = () => stub;
  stub.addToUi = () => stub;
  return stub;
}

function makeTriggerBuilderStub() {
  const stub = {};
  stub.timeBased = () => stub;
  stub.forSpreadsheet = () => stub;
  stub.onOpen = () => stub;
  stub.onEdit = () => stub;
  stub.everyMinutes = () => stub;
  stub.everyHours = () => stub;
  stub.everyDays = () => stub;
  stub.atHour = () => stub;
  stub.create = () => ({ getUniqueId: () => "trigger-id" });
  return stub;
}

// ------------------------------------------------------------
// loadGas
// ------------------------------------------------------------

function loadGas(filePaths, options = {}) {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const props = Object.assign({}, options.props || {});
  const urlFetch = options.urlFetch;

  const ss = new MockSpreadsheet();

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ss,
    getUi: () => ({
      alert: () => {},
      prompt: () => ({ getSelectedButton: () => "OK", getResponseText: () => "" }),
      createMenu: () => makeMenuStub(),
      ButtonSet: { OK: "OK", OK_CANCEL: "OK_CANCEL", YES_NO: "YES_NO" },
      Button: { OK: "OK", CANCEL: "CANCEL", YES: "YES", NO: "NO" },
    }),
  };

  const Utilities = {
    formatDate,
    parseDate,
    sleep: () => {},
    newBlob: (content, type, name) => makeBlob(content, type, name),
  };

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => {
        props[k] = String(v);
      },
      deleteProperty: (k) => {
        delete props[k];
      },
      getProperties: () => Object.assign({}, props),
    }),
  };

  const Logger = { log: () => {} };

  const UrlFetchApp = {
    fetch: (url, params) => {
      if (typeof urlFetch === "function") return urlFetch(url, params);
      return { getResponseCode: () => 200, getContentText: () => "{}" };
    },
  };

  const ContentService = {
    createTextOutput: (s) => ({
      getContent: () => s,
      setMimeType: function () {
        return this;
      },
    }),
    MimeType: { TEXT: "TEXT", JSON: "JSON" },
  };

  // ---- Drive / Blob / Mail mocks (for invoice PDF generation) ----
  const driveFiles = [];
  const mailbox = [];
  const folderRegistry = {};
  let _fileSeq = 0;

  function makeBlob(content, type, name) {
    let _name = name || "blob";
    const blob = {
      getName: () => _name,
      setName: (n) => { _name = n; return blob; },
      getContentType: () => type,
      getDataAsString: () => String(content),
      getBytes: () => (typeof content === "string" ? Array.from(Buffer.from(content)) : []),
      getAs: (t) => makeBlob(content, t, _name),
    };
    return blob;
  }

  function makeFile(blob) {
    _fileSeq++;
    const id = "file-" + _fileSeq;
    const file = {
      _blob: blob,
      getId: () => id,
      getName: () => (blob && blob.getName ? blob.getName() : "file"),
      getUrl: () => "https://drive.google.com/file/d/" + id + "/view",
    };
    driveFiles.push(file);
    return file;
  }

  function makeFolder(name, id) {
    return {
      getId: () => id,
      getName: () => name,
      getUrl: () => "https://drive.google.com/drive/folders/" + id,
      createFile: (blob) => makeFile(blob),
    };
  }

  const DriveApp = {
    getFileById: () => ({ getBlob: () => makeBlob("", "application/octet-stream", "f"), makeCopy: () => ({ getId: () => "copy" }) }),
    getRootFolder: () => makeFolder("root", "root"),
    getFolderById: (id) => makeFolder("folder-" + id, id),
    getFoldersByName: (name) => {
      const existing = folderRegistry[name];
      let used = false;
      return { hasNext: () => !!existing && !used, next: () => { used = true; return existing; } };
    },
    createFolder: (name) => {
      const id = "folder-new-" + name;
      const f = makeFolder(name, id);
      folderRegistry[name] = f;
      return f;
    },
  };

  const MailApp = {
    sendEmail: (a, b, c, d) => { mailbox.push(typeof a === "object" ? a : { to: a, subject: b, body: c, options: d }); },
  };

  const ScriptApp = {
    getProjectTriggers: () => [],
    newTrigger: () => makeTriggerBuilderStub(),
    getOAuthToken: () => "x",
    deleteTrigger: () => {},
  };

  // The sandbox is the global object for the executed GAS code.
  // NOTE: we do NOT inject Object/Array/Date/etc. — the vm context
  // supplies native intrinsics of its own realm, and object/array
  // literals created by the GAS code will use those. (Injecting Node's
  // intrinsics here would not change literal prototypes anyway.)
  // `console` is passed through so the code can log.
  const sandbox = {
    SpreadsheetApp,
    Utilities,
    PropertiesService,
    Logger,
    UrlFetchApp,
    ContentService,
    DriveApp,
    MailApp,
    ScriptApp,
    console,
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  // Concatenate all source files and run as ONE script in the shared scope.
  const code = paths.map((p) => fs.readFileSync(p, "utf8")).join("\n;\n");
  vm.runInContext(code, ctx, { filename: "gas-bundle.js" });

  return { ctx, ss, props, driveFiles, mailbox };
}

module.exports = { loadGas, formatDate, parseDate, MockSheet, MockSpreadsheet };
