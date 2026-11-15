'use strict';

const fs = require('fs-extra');
const path = require('path');
const os = require('os');

function resolveWritableDbPath(dbPath) {
  const fileName = path.basename(dbPath);
  const preferredDir = path.dirname(dbPath);
  try {
    fs.ensureDirSync(preferredDir);
    const probe = path.join(preferredDir, `.write-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return dbPath;
  } catch {
    const fallbackDir = path.join(os.tmpdir(), 'spider-sqlite');
    fs.ensureDirSync(fallbackDir);
    return path.join(fallbackDir, fileName);
  }
}

function splitTopLevel(str, sep = ',') {
  const parts = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "'" && !inDouble) {
      if (inSingle && str[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')' && depth > 0) depth--;
      else if (ch === sep && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseSqlLiteral(raw) {
  const s = raw.trim();
  if (/^NULL$/i.test(s)) return null;
  if (/^\(?\s*unixepoch\(\)\s*\)?$/i.test(s)) return Math.floor(Date.now() / 1000);
  if (/^'(.*)'$/s.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

class CompatDatabase {
  constructor(jsonFilePath) {
    this.filePath = jsonFilePath;
    this.tables = {};
    this._inTx = false;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = fs.readJsonSync(this.filePath);
        if (parsed && typeof parsed === 'object' && parsed.tables) {
          this.tables = parsed.tables;
        }
      }
    } catch {
      this.tables = {};
    }
  }

  _save(force = false) {
    if (this._inTx && !force) {
      this._dirty = true;
      return;
    }
    this._dirty = false;
    try {
      fs.ensureDirSync(path.dirname(this.filePath));
      const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify({ tables: this.tables }), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Best-effort persistence on restricted filesystems
    }
  }

  pragma() {
    return [];
  }

  close() {
    if (this._dirty) this._save(true);
  }

  _ensureTable(name) {
    if (!this.tables[name]) {
      this.tables[name] = {
        columns: [],
        defaults: {},
        primaryKeys: [],
        autoIncrementCol: null,
        nextAutoId: 1,
        nextRowId: 1,
        rows: [],
      };
    }
    return this.tables[name];
  }

  exec(sql) {
    const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/gi;
    let m;
    while ((m = createTableRe.exec(sql)) !== null) {
      const tableName = m[1];
      const body = m[2];
      const tbl = this._ensureTable(tableName);
      const defs = splitTopLevel(body, ',');
      const cols = [];
      const defaults = {};
      const pks = [];
      let autoInc = null;
      for (const def of defs) {
        const pkMatch = def.match(/^PRIMARY\s+KEY\s*\(([^)]+)\)/i);
        if (pkMatch) {
          pkMatch[1]
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
            .forEach((c) => {
              if (!pks.includes(c)) pks.push(c);
            });
          continue;
        }
        if (/^(UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(def)) continue;
        const colMatch = def.match(/^([a-zA-Z0-9_]+)\s+([\s\S]+)$/);
        if (!colMatch) continue;
        const colName = colMatch[1];
        const rest = colMatch[2];
        cols.push(colName);
        if (/\bPRIMARY\s+KEY\b/i.test(rest) && !pks.includes(colName)) {
          pks.push(colName);
        }
        if (/\bAUTOINCREMENT\b/i.test(rest)) {
          autoInc = colName;
        }
        const defValMatch = rest.match(/\bDEFAULT\s+(\([^)]+\)|'[^']*'|[^\s,]+)/i);
        if (defValMatch) {
          defaults[colName] = defValMatch[1];
        }
      }
      if (cols.length) tbl.columns = cols;
      tbl.defaults = { ...tbl.defaults, ...defaults };
      if (pks.length) tbl.primaryKeys = pks;
      if (autoInc) tbl.autoIncrementCol = autoInc;
    }
    this._save();
    return this;
  }

  transaction(fn) {
    return (...args) => {
      const wasInTx = this._inTx;
      this._inTx = true;
      try {
        const res = fn(...args);
        if (!wasInTx) {
          this._inTx = false;
          if (this._dirty) this._save(true);
        }
        return res;
      } catch (err) {
        if (!wasInTx) {
          this._inTx = false;
        }
        throw err;
      }
    };
  }

  _resolveDefault(expr) {
    if (expr === undefined) return null;
    return parseSqlLiteral(String(expr));
  }

  _evalWhere(row, whereClause, args, argCursor) {
    if (!whereClause || !whereClause.trim()) return () => true;
    const norm = whereClause.replace(/\s+/g, ' ').trim();

    // Special case: autoreply (scope = 'global' OR group_jid = ?) combined with AND
    const parts = [];
    let current = '';
    let depth = 0;
    let inSingle = false;
    const tokens = norm.split(/\s+(AND)\s+/i);
    // Split on top-level AND carefully
    for (let i = 0; i < norm.length; i++) {
      const ch = norm[i];
      if (ch === "'" && norm[i - 1] !== '\\') inSingle = !inSingle;
      if (!inSingle) {
        if (ch === '(') depth++;
        else if (ch === ')' && depth > 0) depth--;
        if (depth === 0 && /^AND\b/i.test(norm.slice(i)) && (i === 0 || /\s/.test(norm[i - 1]))) {
          const after = norm.slice(i + 3);
          if (!after || /^\s/.test(after)) {
            parts.push(current.trim());
            current = '';
            i += 2;
            continue;
          }
        }
      }
      current += ch;
    }
    if (current.trim()) parts.push(current.trim());

    const checks = parts.map((cond) => {
      const clean = cond.replace(/^\(([\s\S]+)\)$/, '$1').trim();

      // (scope = 'global' OR group_jid = ?)
      const scopeOrMatch = clean.match(/^([a-zA-Z0-9_]+)\s*=\s*'([^']*)'\s+OR\s+([a-zA-Z0-9_]+)\s*=\s*\?$/i);
      if (scopeOrMatch) {
        const [, c1, v1, c2] = scopeOrMatch;
        const val = args[argCursor.idx++];
        return (r) => r[c1] === v1 || r[c2] === val;
      }

      // rowid NOT IN (SELECT rowid FROM table WHERE jid = ? ORDER BY ts DESC LIMIT 20)
      const notInMatch = clean.match(
        /^rowid\s+NOT\s+IN\s*\(\s*SELECT\s+rowid\s+FROM\s+([a-zA-Z0-9_]+)\s+WHERE\s+([a-zA-Z0-9_]+)\s*=\s*\?\s+ORDER\s+BY\s+([a-zA-Z0-9_]+)\s+(ASC|DESC)\s+LIMIT\s+(\d+)\s*\)$/i,
      );
      if (notInMatch) {
        const [, subTblName, subWhereCol, orderCol, orderDir, limStr] = notInMatch;
        const whereVal = args[argCursor.idx++];
        const lim = Number(limStr);
        const subTbl = this._ensureTable(subTblName);
        const matching = subTbl.rows
          .filter((sr) => sr[subWhereCol] === whereVal)
          .sort((a, b) => {
            const cmp = (a[orderCol] ?? 0) - (b[orderCol] ?? 0);
            if (cmp !== 0) return orderDir.toUpperCase() === 'DESC' ? -cmp : cmp;
            return orderDir.toUpperCase() === 'DESC' ? b._rowid - a._rowid : a._rowid - b._rowid;
          })
          .slice(0, lim);
        const keepIds = new Set(matching.map((mr) => mr._rowid));
        return (r) => !keepIds.has(r._rowid);
      }

      // col IS NOT NULL
      const isNotNull = clean.match(/^([a-zA-Z0-9_]+)\s+IS\s+NOT\s+NULL$/i);
      if (isNotNull) {
        const col = isNotNull[1];
        return (r) => r[col] !== null && r[col] !== undefined;
      }

      // col IS NULL
      const isNull = clean.match(/^([a-zA-Z0-9_]+)\s+IS\s+NULL$/i);
      if (isNull) {
        const col = isNull[1];
        return (r) => r[col] === null || r[col] === undefined;
      }

      // col <op> ? | literal
      const cmpMatch = clean.match(/^([a-zA-Z0-9_]+)\s*(<=|>=|<>|!=|=|<|>)\s*(\?|'[^']*'|-?\d+(?:\.\d+)?)$/i);
      if (cmpMatch) {
        const [, col, op, rhs] = cmpMatch;
        const target = rhs === '?' ? args[argCursor.idx++] : parseSqlLiteral(rhs);
        return (r) => {
          const v = col === 'rowid' ? r._rowid : r[col];
          switch (op) {
            case '=':
              return v === target;
            case '!=':
            case '<>':
              return v !== target;
            case '<':
              return v !== null && v !== undefined && v < target;
            case '<=':
              return v !== null && v !== undefined && v <= target;
            case '>':
              return v !== null && v !== undefined && v > target;
            case '>=':
              return v !== null && v !== undefined && v >= target;
            default:
              return false;
          }
        };
      }

      return () => true;
    });

    return (r) => checks.every((fn) => fn(r));
  }

  prepare(rawSql) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    const execute = (args) => {
      // Normalize single object named parameters vs positional args
      const namedParams =
        args.length === 1 &&
        args[0] &&
        typeof args[0] === 'object' &&
        !Array.isArray(args[0]) &&
        !Buffer.isBuffer(args[0])
          ? args[0]
          : null;

      // 1. INSERT
      const insertMatch = sql.match(
        /^INSERT(?:\s+OR\s+(IGNORE|REPLACE))?\s+INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+?)\)(?:\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+UPDATE\s+SET\s+([\s\S]+))?$/i,
      );
      if (insertMatch) {
        const [, orMode, tableName, colsStr, valsStr, conflictCol, updateSetStr] = insertMatch;
        const tbl = this._ensureTable(tableName);
        const cols = colsStr.split(',').map((c) => c.trim());
        const valExprs = splitTopLevel(valsStr, ',');
        let posIdx = 0;

        const row = {};
        for (const col of tbl.columns) {
          if (col in tbl.defaults) row[col] = this._resolveDefault(tbl.defaults[col]);
          else row[col] = null;
        }

        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const expr = (valExprs[i] || '').trim();
          if (expr === '?') {
            row[col] = args[posIdx++];
          } else if (expr.startsWith('@') || expr.startsWith(':') || expr.startsWith('$')) {
            const key = expr.slice(1);
            row[col] = namedParams ? namedParams[key] ?? null : null;
          } else {
            row[col] = parseSqlLiteral(expr);
          }
        }

        const pks = tbl.primaryKeys.length
          ? tbl.primaryKeys
          : conflictCol
            ? conflictCol.split(',').map((c) => c.trim())
            : [];

        const matchesPk = (existing) =>
          pks.length > 0 && pks.every((pk) => existing[pk] !== undefined && existing[pk] === row[pk]);

        const existingIdx = tbl.rows.findIndex(matchesPk);
        if (existingIdx !== -1) {
          if (orMode && orMode.toUpperCase() === 'IGNORE') {
            return { changes: 0, lastInsertRowid: tbl.rows[existingIdx]._rowid };
          }
          if (orMode && orMode.toUpperCase() === 'REPLACE') {
            const existing = tbl.rows[existingIdx];
            row._rowid = tbl.nextRowId++;
            if (tbl.autoIncrementCol && (row[tbl.autoIncrementCol] === null || row[tbl.autoIncrementCol] === undefined)) {
              row[tbl.autoIncrementCol] = existing[tbl.autoIncrementCol] ?? tbl.nextAutoId++;
            }
            tbl.rows[existingIdx] = row;
            this._save();
            return {
              changes: 1,
              lastInsertRowid: tbl.autoIncrementCol ? row[tbl.autoIncrementCol] : row._rowid,
            };
          }
          if (updateSetStr) {
            const existing = tbl.rows[existingIdx];
            const assignments = splitTopLevel(updateSetStr, ',');
            for (const assign of assignments) {
              const am = assign.match(/^([a-zA-Z0-9_]+)\s*=\s*([\s\S]+)$/);
              if (!am) continue;
              const col = am[1].trim();
              const rhs = am[2].trim();
              if (rhs.startsWith('@') || rhs.startsWith(':') || rhs.startsWith('$')) {
                existing[col] = namedParams ? namedParams[rhs.slice(1)] ?? null : null;
              } else if (rhs === '?') {
                existing[col] = args[posIdx++];
              } else {
                existing[col] = parseSqlLiteral(rhs);
              }
            }
            this._save();
            return {
              changes: 1,
              lastInsertRowid: tbl.autoIncrementCol ? existing[tbl.autoIncrementCol] : existing._rowid,
            };
          }
        }

        if (tbl.autoIncrementCol && (row[tbl.autoIncrementCol] === null || row[tbl.autoIncrementCol] === undefined)) {
          row[tbl.autoIncrementCol] = tbl.nextAutoId++;
        }
        row._rowid = tbl.nextRowId++;
        tbl.rows.push(row);
        this._save();
        return {
          changes: 1,
          lastInsertRowid: tbl.autoIncrementCol ? row[tbl.autoIncrementCol] : row._rowid,
        };
      }

      // 2. UPDATE
      const updateMatch = sql.match(/^UPDATE\s+([a-zA-Z0-9_]+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (updateMatch) {
        const [, tableName, setStr, whereStr] = updateMatch;
        const tbl = this._ensureTable(tableName);
        const assignments = splitTopLevel(setStr, ',');
        const cursor = { idx: 0 };

        const updaters = assignments.map((assign) => {
          const am = assign.match(/^([a-zA-Z0-9_]+)\s*=\s*([\s\S]+)$/);
          if (!am) return () => {};
          const col = am[1].trim();
          const rhs = am[2].trim();

          // CASE WHEN is_active = 1 THEN 0 ELSE 1 END
          const toggleMatch = rhs.match(/^CASE\s+WHEN\s+([a-zA-Z0-9_]+)\s*=\s*1\s+THEN\s+0\s+ELSE\s+1\s+END$/i);
          if (toggleMatch) {
            const targetCol = toggleMatch[1];
            return (r) => {
              r[col] = r[targetCol] === 1 ? 0 : 1;
            };
          }

          // col = col + ? or col = col + 1
          const addMatch = rhs.match(/^([a-zA-Z0-9_]+)\s*([+-])\s*(\?|\d+(?:\.\d+)?)$/);
          if (addMatch) {
            const [, srcCol, op, term] = addMatch;
            const delta = term === '?' ? Number(args[cursor.idx++]) : Number(term);
            const signed = op === '-' ? -delta : delta;
            return (r) => {
              r[col] = Number(r[srcCol] || 0) + signed;
            };
          }

          if (rhs === '?') {
            const val = args[cursor.idx++];
            return (r) => {
              r[col] = val;
            };
          }

          const lit = parseSqlLiteral(rhs);
          return (r) => {
            r[col] = lit;
          };
        });

        const pred = this._evalWhere(null, whereStr || '', args, cursor);
        let changes = 0;
        for (const r of tbl.rows) {
          if (pred(r)) {
            for (const fn of updaters) fn(r);
            changes++;
          }
        }
        if (changes > 0) this._save();
        return { changes };
      }

      // 3. DELETE
      const deleteMatch = sql.match(/^DELETE\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+))?$/i);
      if (deleteMatch) {
        const [, tableName, whereStr] = deleteMatch;
        const tbl = this._ensureTable(tableName);
        const cursor = { idx: 0 };
        const pred = this._evalWhere(null, whereStr || '', args, cursor);
        const before = tbl.rows.length;
        tbl.rows = tbl.rows.filter((r) => !pred(r));
        const changes = before - tbl.rows.length;
        if (changes > 0) this._save();
        return { changes };
      }

      // 4. SELECT
      const selectMatch = sql.match(
        /^SELECT\s+([\s\S]+?)\s+FROM\s+([a-zA-Z0-9_]+)(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([a-zA-Z0-9_]+))?(?:\s+ORDER\s+BY\s+([a-zA-Z0-9_]+)(?:\s+(ASC|DESC))?)?(?:\s+LIMIT\s+(\?|\d+))?(?:\s+OFFSET\s+(\?|\d+))?$/i,
      );
      if (selectMatch) {
        const [, selectStr, tableName, whereStr, groupByCol, orderCol, orderDir, limitTok, offsetTok] = selectMatch;
        const tbl = this._ensureTable(tableName);
        const cursor = { idx: 0 };
        const pred = this._evalWhere(null, whereStr || '', args, cursor);
        let rows = tbl.rows.filter(pred);

        const limit =
          limitTok === '?' ? Number(args[cursor.idx++]) : limitTok !== undefined ? Number(limitTok) : null;
        const offset =
          offsetTok === '?' ? Number(args[cursor.idx++]) : offsetTok !== undefined ? Number(offsetTok) : 0;

        const selectCols = splitTopLevel(selectStr, ',');
        const hasAggregate = selectCols.some((c) => /\b(COUNT|SUM)\s*\(/i.test(c));

        if (groupByCol) {
          const groups = new Map();
          for (const r of rows) {
            const key = r[groupByCol];
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(r);
          }
          const out = [];
          for (const [key, grpRows] of groups.entries()) {
            const obj = {};
            for (const expr of selectCols) {
              const cntMatch = expr.match(/^COUNT\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i);
              if (cntMatch) {
                obj[cntMatch[1] || 'COUNT(*)'] = grpRows.length;
                continue;
              }
              const aliasMatch = expr.match(/^([a-zA-Z0-9_]+)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i);
              if (aliasMatch) {
                obj[aliasMatch[2] || aliasMatch[1]] = aliasMatch[1] === groupByCol ? key : grpRows[0]?.[aliasMatch[1]];
              }
            }
            out.push(obj);
          }
          return out;
        }

        if (hasAggregate) {
          const agg = {};
          for (const expr of selectCols) {
            const cntMatch = expr.match(/^COUNT\(\*\)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i);
            if (cntMatch) {
              agg[cntMatch[1] || 'COUNT(*)'] = rows.length;
              continue;
            }
            const sumMatch = expr.match(/^SUM\(([a-zA-Z0-9_]+)\)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i);
            if (sumMatch) {
              const col = sumMatch[1];
              const alias = sumMatch[2] || `SUM(${col})`;
              agg[alias] = rows.length === 0 ? null : rows.reduce((acc, r) => acc + Number(r[col] || 0), 0);
            }
          }
          return [agg];
        }

        if (orderCol) {
          const dir = (orderDir || 'ASC').toUpperCase();
          rows = [...rows].sort((a, b) => {
            const va = orderCol === 'rowid' ? a._rowid : a[orderCol];
            const vb = orderCol === 'rowid' ? b._rowid : b[orderCol];
            if (va === vb) return dir === 'DESC' ? b._rowid - a._rowid : a._rowid - b._rowid;
            if (va === null || va === undefined) return 1;
            if (vb === null || vb === undefined) return -1;
            const cmp = va < vb ? -1 : 1;
            return dir === 'DESC' ? -cmp : cmp;
          });
        }

        if (offset || limit !== null) {
          rows = rows.slice(offset, limit !== null ? offset + limit : undefined);
        }

        if (selectCols.length === 1 && selectCols[0] === '*') {
          return rows.map(({ _rowid, ...rest }) => ({ ...rest }));
        }

        return rows.map((r) => {
          const obj = {};
          for (const expr of selectCols) {
            const am = expr.match(/^([a-zA-Z0-9_]+)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i);
            if (am) {
              const src = am[1];
              const alias = am[2] || src;
              obj[alias] = src === 'rowid' ? r._rowid : r[src];
            }
          }
          return obj;
        });
      }

      return [];
    };

    return {
      run: (...args) => execute(args),
      get: (...args) => {
        const res = execute(args);
        return Array.isArray(res) ? res[0] : undefined;
      },
      all: (...args) => {
        const res = execute(args);
        return Array.isArray(res) ? res : [];
      },
    };
  }
}

function openSqliteCompat(dbPath) {
  const resolved = resolveWritableDbPath(dbPath);
  try {
    const BetterSqlite3 = require('better-sqlite3');
    const instance = new BetterSqlite3(resolved);
    return instance;
  } catch {
    return new CompatDatabase(`${resolved}.json`);
  }
}

module.exports = openSqliteCompat;
module.exports.openSqliteCompat = openSqliteCompat;
module.exports.CompatDatabase = CompatDatabase;
module.exports.resolveWritableDbPath = resolveWritableDbPath;
