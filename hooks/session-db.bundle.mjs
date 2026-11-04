import{createRequire as ce}from"node:module";import{existsSync as ue,unlinkSync as H,renameSync as de}from"node:fs";import{tmpdir as le}from"node:os";import{join as ge}from"node:path";var w=class{#e;constructor(e){this.#e=e}pragma(e){let n=this.#e.prepare(`PRAGMA ${e}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let s=Object.values(n[0]);return s.length===1?s[0]:n[0]}exec(e){let t="",n=null;for(let a=0;a<e.length;a++){let i=e[a];if(n)t+=i,i===n&&(n=null);else if(i==="'"||i==='"')t+=i,n=i;else if(i===";"){let c=t.trim();c&&this.#e.prepare(c).run(),t=""}else t+=i}let s=t.trim();return s&&this.#e.prepare(s).run(),this}prepare(e){let t=this.#e.prepare(e);return{run:(...n)=>t.run(...n),get:(...n)=>{let s=t.get(...n);return s===null?void 0:s},all:(...n)=>t.all(...n),iterate:(...n)=>t.iterate(...n)}}transaction(e){return this.#e.transaction(e)}close(){this.#e.close()}},x=class{#e;constructor(e){this.#e=e}pragma(e){let n=this.#e.prepare(`PRAGMA ${e}`).all();if(!n||n.length===0)return;if(n.length>1)return n;let s=Object.values(n[0]);return s.length===1?s[0]:n[0]}exec(e){return this.#e.exec(e),this}prepare(e){let t=this.#e.prepare(e);return{run:(...n)=>t.run(...n),get:(...n)=>t.get(...n),all:(...n)=>t.all(...n),iterate:(...n)=>typeof t.iterate=="function"?t.iterate(...n):t.all(...n)[Symbol.iterator]()}}transaction(e){return(...t)=>{this.#e.exec("BEGIN");try{let n=e(...t);return this.#e.exec("COMMIT"),n}catch(n){throw this.#e.exec("ROLLBACK"),n}}}close(){this.#e.close()}},E=null;function Ee(r){let e=null;try{return e=new r(":memory:"),e.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{e?.close()}catch{}}}function me(r,e){let t=e!==void 0?e:globalThis.Bun;if(typeof t<"u"&&t!==null)return!0;let n=r??process.versions,[s,a]=(n.node??"0.0.0").split("."),i=Number(s),c=Number(a);return!Number.isFinite(i)||!Number.isFinite(c)?!1:i>22||i===22&&c>=5}function _e(){if(!E){let r=ce(import.meta.url);if(globalThis.Bun){let e=r(["bun","sqlite"].join(":")).Database;E=function(n,s){let a=new e(n,{readonly:s?.readonly,create:!0}),i=new w(a);return s?.timeout&&i.pragma(`busy_timeout = ${s.timeout}`),i}}else if(me()){let e=null;try{({DatabaseSync:e}=r(["node","sqlite"].join(":")))}catch{e=null}e&&Ee(e)?E=function(n,s){let a=new e(n,{readOnly:s?.readonly??!1}),i=new x(a);return s?.timeout&&i.pragma(`busy_timeout = ${s.timeout}`),i}:E=r("better-sqlite3")}else E=r("better-sqlite3")}return E}function B(r){r.pragma("journal_mode = WAL"),r.pragma("synchronous = NORMAL");try{r.pragma("mmap_size = 268435456")}catch{}}function j(r){if(!ue(r))for(let e of["-wal","-shm"])try{H(r+e)}catch{}}function pe(r){for(let e of["","-wal","-shm"])try{H(r+e)}catch{}}function I(r){try{r.pragma("wal_checkpoint(TRUNCATE)")}catch{}try{r.close()}catch{}}function V(r="context-mode"){return ge(le(),`${r}-${process.pid}.db`)}function ye(r,e=[100,500,2e3]){let t;for(let n=0;n<=e.length;n++)try{return r()}catch(s){let a=s instanceof Error?s.message:String(s);if(!a.includes("SQLITE_BUSY")&&!a.includes("database is locked"))throw s;if(t=s instanceof Error?s:new Error(a),n<e.length){let i=e[n],c=Date.now();for(;Date.now()-c<i;);}}throw new Error(`SQLITE_BUSY: database is locked after ${e.length} retries. Original error: ${t?.message}`)}function Se(r){return r.includes("SQLITE_CORRUPT")||r.includes("SQLITE_NOTADB")||r.includes("database disk image is malformed")||r.includes("file is not a database")}function fe(r){let e=Date.now();for(let t of["","-wal","-shm"])try{de(r+t,`${r}${t}.corrupt-${e}`)}catch{}}var S=Symbol.for("__context_mode_live_dbs_v3__"),A=(()=>{let r=globalThis;return r[S]||(r[S]=new Set,process.on("exit",()=>{for(let e of r[S])I(e);r[S].clear()})),r[S]})(),T=class{#e;#t;constructor(e){let t=_e();this.#e=e,j(e);let n;try{n=new t(e,{timeout:3e4}),B(n)}catch(s){let a=s instanceof Error?s.message:String(s);if(Se(a)){fe(e),j(e);try{n=new t(e,{timeout:3e4}),B(n)}catch(i){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${i instanceof Error?i.message:String(i)}`)}}else throw s}this.#t=n,A.add(this.#t),this.initSchema(),this.prepareStatements()}get db(){return this.#t}get dbPath(){return this.#e}close(){A.delete(this.#t),I(this.#t)}withRetry(e){return ye(e)}cleanup(){A.delete(this.#t),I(this.#t),pe(this.#e)}};import{createHash as re}from"node:crypto";import{createHash as M}from"node:crypto";import{execFileSync as he}from"node:child_process";import{existsSync as v,realpathSync as Te,renameSync as U}from"node:fs";import{join as R}from"node:path";var m;function g(r){let e=r.replace(/\\/g,"/");return/^\/+$/.test(e)?"/":/^[A-Za-z]:\/+$/.test(e)?`${e.slice(0,2)}/`:e.replace(/\/+$/,"")}function W(r){let e=r;try{e=Te.native(r)}catch{}let t=g(e);return process.platform==="win32"||process.platform==="darwin"?t.toLowerCase():t}function X(r,e){return he("git",["-C",r,...e],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function ve(r){let e=X(r,["rev-parse","--show-toplevel"]);return e.length>0?g(e):null}function Re(r){let e=X(r,["worktree","list","--porcelain"]).split(/\r?\n/).find(t=>t.startsWith("worktree "))?.replace("worktree ","")?.trim();return e?g(e):null}function be(r=process.cwd()){let e=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(m&&m.projectDir===r&&m.envSuffix===e)return m.suffix;let t="";if(e!==void 0)t=e?`__${e}`:"";else try{let n=ve(r),s=Re(r);if(n&&s){let a=W(n),i=W(s);a!==i&&(t=`__${M("sha256").update(a).digest("hex").slice(0,8)}`)}}catch{}return m={projectDir:r,envSuffix:e,suffix:t},t}function Ge(){m=void 0}function $(r){return M("sha256").update(g(r)).digest("hex").slice(0,16)}function q(r){let e=g(r),t=process.platform==="darwin"||process.platform==="win32"?e.toLowerCase():e;return M("sha256").update(t).digest("hex").slice(0,16)}function Ye(r){let{projectDir:e,contentDir:t}=r,n=q(e),s=R(t,`${n}.db`);if(v(s))return s;let a=$(e);if(a===n)return s;let i=R(t,`${a}.db`);if(v(i))try{U(i,s);for(let c of["-wal","-shm"])try{U(i+c,s+c)}catch{}}catch{}return s}function Ke(r){return De({...r,ext:".db"})}function De(r){let{projectDir:e,sessionsDir:t,ext:n}=r,s=r.suffix??be(e),a=q(e),i=R(t,`${a}${s}${n}`);if(v(i))return i;let c=$(e);if(c===a)return i;let d=R(t,`${c}${s}${n}`);if(v(d))try{U(d,i)}catch{}return i}import{accessSync as Le,constants as Ne,mkdirSync as Ce}from"node:fs";import{homedir as K}from"node:os";import{dirname as Oe,isAbsolute as z,join as D,resolve as _}from"node:path";var l="CONTEXT_MODE_DIR",Q="sessions",G="content",f=class extends Error{kind;path;overrideEnvVar;ignoredEnvVar;ignoredReason;constructor(e,t,n=l,s,a,i={}){super(a??Ue(e,t,i),{cause:s}),this.name="StorageDirectoryError",this.kind=e,this.path=t,this.overrideEnvVar=n,this.ignoredEnvVar=i.ignoredEnvVar,this.ignoredReason=i.ignoredReason}},b=new Map;function et(r){let e=r.env??process.env,t=r.legacySessionDirEnv,n=t?e[t]?.trim():void 0;return n&&t?(r.onLegacySessionDir?.(t,n),n):D(Ae(r.configDir,r.configDirEnv,e),"context-mode","sessions")}function Ae(r,e,t){let n=e?t[e]:void 0;return n&&n.trim()!==""?Y(n.trim()):Y(r,K())}function Y(r,e){return r.startsWith("~")?_(K(),r.replace(/^~[/\\]?/,"")):z(r)?_(r):e?_(e,r):_(r)}function we(r,e,t){return new f(r,e,l,void 0,[`Invalid ${l} for context-mode ${r} directory: ${t}`,te()].join(`
`))}function J(r){let e=process.env[l];if(e===void 0)return{kind:"unset"};let t=e.trim();if(!t)return{kind:"ignored-empty",ignoredEnvVar:l,ignoredReason:"empty"};if(!z(t))throw we(r,t,`${l} must be an absolute path.`);return{kind:"override",root:_(t)}}function xe(r){return r.kind==="ignored-empty"?{ignoredEnvVar:r.ignoredEnvVar,ignoredReason:r.ignoredReason}:{}}function Z(r,e){let t=J(r);return t.kind!=="override"?null:{kind:r,path:D(t.root,e),envVar:l,source:"override"}}function Ie(r,e,t){return{kind:r,path:_(e()),envVar:null,source:"default",...t}}function ee(r){let e=J("session");return e.kind==="override"?{kind:"session",path:D(e.root,Q),envVar:l,source:"override"}:Ie("session",r,xe(e))}function tt(r){let e=Z("content",G);if(e)return e;let t=ee(r);return{kind:"content",path:D(Oe(t.path),G),envVar:t.envVar,source:t.source,ignoredEnvVar:t.ignoredEnvVar,ignoredReason:t.ignoredReason}}function rt(r){let e=Z("stats",Q);if(e)return e;let t=ee(r);return{kind:"stats",path:t.path,envVar:t.envVar,source:t.source,ignoredEnvVar:t.ignoredEnvVar,ignoredReason:t.ignoredReason}}function nt(r){return r.message}function st(r){return r.source==="override"&&r.envVar?`via ${r.envVar}`:r.ignoredEnvVar&&r.ignoredReason==="empty"?`default; ignored empty ${r.ignoredEnvVar}`:"default"}function ot(){b.clear()}function it(r){let e=[r.kind,r.path,r.source,r.envVar??"",r.ignoredEnvVar??"",r.ignoredReason??""].join("\0"),t=b.get(e);if(t instanceof f)throw t;if(t===r.path)return t;try{return Ce(r.path,{recursive:!0}),Le(r.path,Ne.W_OK),b.set(e,r.path),r.path}catch(n){let s=new f(r.kind,ke(n)??r.path,l,n,void 0,{ignoredEnvVar:r.ignoredEnvVar,ignoredReason:r.ignoredReason});throw b.set(e,s),s}}function Ue(r,e,t={}){return[`context-mode ${r} directory is not writable: ${e}`,Me(t),te()].filter(Boolean).join(`
`)}function Me(r){return r.ignoredEnvVar&&r.ignoredReason==="empty"?`Ignored empty ${r.ignoredEnvVar}; using adapter default.`:null}function te(){return`Set ${l} to a writable absolute path.`}function ke(r){if(!r||typeof r!="object")return null;let e=r.path;return typeof e=="string"&&e.length>0?e:null}var ne=1e3,k=5;function L(r){let e=Number(r);return!Number.isFinite(e)||e<=0?0:Math.floor(e)}var o={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",checkDuplicateBySource:"checkDuplicateBySource",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",getSessionRollup:"getSessionRollup",getMaxFileEdits:"getMaxFileEdits",getLatestCommitMessage:"getLatestCommitMessage",incrementCompactCount:"incrementCompactCount",getUsageCursor:"getUsageCursor",setUsageCursor:"setUsageCursor",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool",getEventBytesSummary:"getEventBytesSummary"},Fe=[["project_dir","TEXT NOT NULL DEFAULT ''"],["attribution_source","TEXT NOT NULL DEFAULT 'unknown'"],["attribution_confidence","REAL NOT NULL DEFAULT 0"],["bytes_avoided","INTEGER NOT NULL DEFAULT 0"],["bytes_returned","INTEGER NOT NULL DEFAULT 0"]];function oe(r){let e=r.pragma("table_xinfo(session_events)"),t=new Set(e.map(s=>s.name)),n=!1;for(let[s,a]of Fe)t.has(s)||(r.exec(`ALTER TABLE session_events ADD COLUMN ${s} ${a}`),n=!0);return n&&r.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)"),n}function lt(r,e){let t=null;try{t=new e(r),oe(t)}catch{}finally{try{t?.close()}catch{}}}var se=class extends T{constructor(e){super(e?.dbPath??V("session"))}stmt(e){return this.stmts.get(e)}initSchema(){try{let t=this.db.pragma("table_xinfo(session_events)").find(n=>n.name==="data_hash");t&&t.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch{}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);try{oe(this.db)}catch{}try{this.db.pragma("table_xinfo(session_meta)").some(t=>t.name==="usage_cursor")||this.db.exec("ALTER TABLE session_meta ADD COLUMN usage_cursor TEXT")}catch{}}prepareStatements(){this.stmts=new Map;let e=(t,n)=>{this.stmts.set(t,this.db.prepare(n))};e(o.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),e(o.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),e(o.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),e(o.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),e(o.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),e(o.checkDuplicateBySource,`SELECT 1 FROM (
         SELECT type, data_hash, source_hook FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ? AND recent.source_hook = ?
       LIMIT 1`),e(o.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),e(o.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),e(o.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),e(o.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),e(o.getSessionRollup,`SELECT
         COUNT(*) AS tool_calls,
         COALESCE(SUM(CASE WHEN category = 'error' THEN 1 ELSE 0 END), 0) AS errors,
         COUNT(DISTINCT type) AS unique_tools,
         COUNT(DISTINCT CASE WHEN category = 'file' THEN data END) AS unique_files,
         CASE WHEN SUM(CASE WHEN type = 'git_commit' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS has_commit,
         CAST(COALESCE((MAX(strftime('%s', created_at)) - MIN(strftime('%s', created_at))) / 60.0, 0) AS INTEGER) AS duration_min,
         COALESCE(SUM(CASE WHEN type = 'external_ref' THEN 1 ELSE 0 END), 0) AS sources_indexed,
         CAST(COALESCE(SUM(bytes_avoided) / 1024.0, 0) AS INTEGER) AS total_chunks,
         COALESCE(SUM(CASE WHEN type IN ('file_search', 'file_glob') THEN 1 ELSE 0 END), 0) AS search_queries
       FROM session_events
       WHERE session_id = ?`),e(o.getMaxFileEdits,`SELECT COALESCE(MAX(c), 0) AS max_file_edits
       FROM (
         SELECT COUNT(*) AS c
         FROM session_events
         WHERE session_id = ? AND category = 'file' AND type IN ('file_edit', 'file_write')
         GROUP BY data
       )`),e(o.getLatestCommitMessage,`SELECT data
       FROM session_events
       WHERE session_id = ? AND type = 'git_commit'
       ORDER BY id DESC
       LIMIT 1`),e(o.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),e(o.getUsageCursor,"SELECT usage_cursor FROM session_meta WHERE session_id = ?"),e(o.setUsageCursor,"UPDATE session_meta SET usage_cursor = ? WHERE session_id = ?"),e(o.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),e(o.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),e(o.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),e(o.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),e(o.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),e(o.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),e(o.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),e(o.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE (project_dir = ? OR project_dir = '')
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),e(o.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),e(o.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),e(o.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),e(o.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`),e(o.getEventBytesSummary,`SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`)}insertEvent(e,t,n="PostToolUse",s,a,i){let c=re("sha256").update(t.data).digest("hex").slice(0,16).toUpperCase(),d=String(s?.projectDir??t.project_dir??this._getSessionProjectDir(e)).trim(),u=String(s?.source??t.attribution_source??"unknown"),p=Number(s?.confidence??t.attribution_confidence??0),y=Number.isFinite(p)?Math.max(0,Math.min(1,p)):0,h=L(a?.bytesAvoided),N=L(a?.bytesReturned),C=this.db.transaction(()=>{if(i?.dedupBySource?this.stmt(o.checkDuplicateBySource).get(e,k,t.type,c,n):this.stmt(o.checkDuplicate).get(e,k,t.type,c))return;this.stmt(o.getEventCount).get(e).cnt>=ne&&this.stmt(o.evictLowestPriority).run(e),this.stmt(o.insertEvent).run(e,t.type,t.category,t.priority,t.data,d,u,y,h,N,n,c),this.stmt(o.updateMetaLastEvent).run(e)});this.withRetry(()=>C())}bulkInsertEvents(e,t,n="PostToolUse",s,a){if(!t||t.length===0)return;if(t.length===1){this.insertEvent(e,t[0],n,s?.[0],a?.[0]);return}let i=t.map((d,u)=>{let p=re("sha256").update(d.data).digest("hex").slice(0,16).toUpperCase(),y=s?.[u],h=String(y?.projectDir??d.project_dir??this._getSessionProjectDir(e)??"").trim(),N=h===""?"":g(h),C=String(y?.source??d.attribution_source??"unknown"),O=Number(y?.confidence??d.attribution_confidence??0),F=Number.isFinite(O)?Math.max(0,Math.min(1,O)):0,P=a?.[u],ie=L(P?.bytesAvoided),ae=L(P?.bytesReturned);return{event:d,dataHash:p,projectDir:N,attributionSource:C,attributionConfidence:F,bytesAvoided:ie,bytesReturned:ae}}),c=this.db.transaction(()=>{let d=this.stmt(o.getEventCount).get(e).cnt;for(let u of i)this.stmt(o.checkDuplicate).get(e,k,u.event.type,u.dataHash)||(d>=ne?this.stmt(o.evictLowestPriority).run(e):d++,this.stmt(o.insertEvent).run(e,u.event.type,u.event.category,u.event.priority,u.event.data,u.projectDir,u.attributionSource,u.attributionConfidence,u.bytesAvoided,u.bytesReturned,n,u.dataHash));this.stmt(o.updateMetaLastEvent).run(e)});this.withRetry(()=>c())}getEvents(e,t){let n=t?.limit??1e3,s=t?.type,a=t?.minPriority;return s&&a!==void 0?this.stmt(o.getEventsByTypeAndPriority).all(e,s,a,n):s?this.stmt(o.getEventsByType).all(e,s,n):a!==void 0?this.stmt(o.getEventsByPriority).all(e,a,n):this.stmt(o.getEvents).all(e,n)}getEventCount(e){return this.stmt(o.getEventCount).get(e).cnt}getEventBytesSummary(e){let t=this.stmt(o.getEventBytesSummary).get(e);return{bytesAvoided:Number(t?.bytes_avoided??0),bytesReturned:Number(t?.bytes_returned??0)}}getLatestAttributedProjectDir(e){return this.stmt(o.getLatestAttributedProject).get(e)?.project_dir||null}_getSessionProjectDir(e){try{return this.db.prepare("SELECT project_dir FROM session_meta WHERE session_id = ?").get(e)?.project_dir||""}catch{return""}}searchEvents(e,t,n,s){try{let a=e.replace(/[%_]/g,c=>"\\"+c),i=s??null;return this.stmt(o.searchEvents).all(n,a,a,i,i,t)}catch{return[]}}getSessionIdsForProject(e){try{let t=g(e);return this.db.prepare(`SELECT DISTINCT session_id
             FROM session_events
            WHERE RTRIM(REPLACE(project_dir, '\\', '/'), '/') = ?`).all(t).map(s=>s.session_id)}catch{return[]}}ensureSession(e,t){this.stmt(o.ensureSession).run(e,t)}getSessionStats(e){return this.stmt(o.getSessionStats).get(e)??null}getSessionRollup(e){let t=this.stmt(o.getSessionRollup).get(e),n=this.stmt(o.getMaxFileEdits).get(e),s=this.stmt(o.getLatestCommitMessage).get(e),a=this.getSessionStats(e),i=(t?.tool_calls??0)>0?t?.unique_files??0:0,c=t?.errors??0,d=Math.min(i,c);return{tool_calls:t?.tool_calls??0,errors:t?.errors??0,unique_tools:t?.unique_tools??0,unique_files:t?.unique_files??0,max_file_edits:n?.max_file_edits??0,has_commit:t?.has_commit??0,commit_message:s?.data??"",edit_test_cycles:d,duration_min:t?.duration_min??0,compact_count:a?.compact_count??0,sources_indexed:t?.sources_indexed??0,total_chunks:t?.total_chunks??0,search_queries:t?.search_queries??0}}incrementCompactCount(e){this.stmt(o.incrementCompactCount).run(e)}getUsageCursor(e){return this.stmt(o.getUsageCursor).get(e)?.usage_cursor??null}setUsageCursor(e,t){this.stmt(o.setUsageCursor).run(t,e)}upsertResume(e,t,n){this.stmt(o.upsertResume).run(e,t,n??0)}getResume(e){return this.stmt(o.getResume).get(e)??null}markResumeConsumed(e){this.stmt(o.markResumeConsumed).run(e)}claimLatestUnconsumedResume(e){let t=this.stmt(o.claimLatestUnconsumedResume).get(e);return t?{sessionId:t.session_id,snapshot:t.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch{return null}}incrementToolCall(e,t,n=0){let s=Number.isFinite(n)&&n>0?Math.round(n):0;try{this.stmt(o.incrementToolCall).run(e,t,s)}catch{}}getToolCallStats(e){try{let t=this.stmt(o.getToolCallTotals).get(e),n=this.stmt(o.getToolCallByTool).all(e),s={};for(let a of n)s[a.tool]={calls:a.calls,bytesReturned:a.bytes_returned};return{totalCalls:t?.calls??0,totalBytesReturned:t?.bytes_returned??0,byTool:s}}catch{return{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(e){this.db.transaction(()=>{this.stmt(o.deleteEvents).run(e),this.stmt(o.deleteResume).run(e),this.stmt(o.deleteMeta).run(e)})()}cleanupOldSessions(e=7){let t=`-${e}`,n=this.stmt(o.getOldSessions).all(t);for(let{session_id:s}of n)this.deleteSession(s);return n.length}pruneOrphanedEvents(){let e=this.db.prepare("DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)").run();return Number(e.changes??0)}};export{se as SessionDB,f as StorageDirectoryError,Ge as _resetWorktreeSuffixCacheForTests,oe as applyMissingSessionEventsColumns,ot as clearStorageDirectoryCheckCacheForTests,st as describeStorageDirectorySource,lt as ensureSessionEventsSchema,it as ensureWritableStorageDir,nt as formatStorageDirectoryError,be as getWorktreeSuffix,q as hashProjectDirCanonical,$ as hashProjectDirLegacy,g as normalizeWorktreePath,tt as resolveContentStorageDir,Ye as resolveContentStorePath,et as resolveDefaultSessionDir,Ke as resolveSessionDbPath,De as resolveSessionPath,ee as resolveSessionStorageDir,rt as resolveStatsStorageDir};
