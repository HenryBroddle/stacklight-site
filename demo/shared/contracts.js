// Machine Shop HUD — shared contracts (pure ESM; imported by the server AND the browser via /shared/contracts.js).
// Source of truth for enums, status metadata and data shapes. See docs/ARCHITECTURE.md.
// Keep this file free of Node or DOM APIs.

export const LAYOUT_SCHEMA = 'machine-shop-hud/layout@1';

/** Derived machine status values (docs/DECISIONS.md D1). STOPPED is folded into IDLE; WAIT counts as RUNNING. */
export const STATUS = Object.freeze({
  ESTOP: 'ESTOP',
  ALARM: 'ALARM',
  PAUSED: 'PAUSED',
  SETUP: 'SETUP',
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  UNAVAILABLE: 'UNAVAILABLE',
  OFFLINE: 'OFFLINE',
  UNBOUND: 'UNBOUND',
});

/** Most urgent first — used for sorting attention lists and summary chips. */
export const STATUS_ORDER = Object.freeze([
  'ESTOP', 'ALARM', 'PAUSED', 'OFFLINE', 'UNAVAILABLE', 'SETUP', 'IDLE', 'RUNNING', 'UNBOUND',
]);

/** Board chip families in fixed display order (D4). */
export const STATUS_FAMILIES = Object.freeze([
  { id: 'estop', label: 'E-STOP', statuses: ['ESTOP'] },
  { id: 'alarm', label: 'ALARM', statuses: ['ALARM'] },
  { id: 'paused', label: 'PAUSED', statuses: ['PAUSED'] },
  { id: 'setup', label: 'SETUP', statuses: ['SETUP'] },
  { id: 'idle', label: 'IDLE', statuses: ['IDLE'] },
  { id: 'nodata', label: 'NO DATA', statuses: ['OFFLINE', 'UNAVAILABLE'] },
]);

/**
 * Presentation metadata (docs/DECISIONS.md D2) — palette validated for WCAG contrast and colour-vision deficiency
 * against #0b0f14 (dark) and #f4f6f8 (light). Colour is never the only cue: each status has a word, an icon with a
 * distinct silhouette, ink polarity and (for no-data / E-stop) a pattern.
 * `fill`/`ink` = dark theme, `fillLight`/`inkLight` = light theme; `border` = 'solid' | 'dashed' | 'none';
 * `outlineLight` = extra dark outline needed in the light theme; `producing` = counts as productive time.
 */
export const STATUS_META = Object.freeze({
  ESTOP:       { word: 'E-STOP',     label: 'Emergency stop', fill: '#dc2626', ink: '#ffffff', fillLight: '#c81e1e', inkLight: '#ffffff', border: 'solid',  pattern: 'hazard', icon: 'octagon',   family: 'estop',  severity: 5, producing: false },
  ALARM:       { word: 'ALARM',      label: 'Alarm',          fill: '#dc2626', ink: '#ffffff', fillLight: '#c81e1e', inkLight: '#ffffff', border: 'solid',  pattern: null,     icon: 'triangle',  family: 'alarm',  severity: 4, producing: false },
  PAUSED:      { word: 'PAUSED',     label: 'Paused',         fill: '#fbbf24', ink: '#0b0f14', fillLight: '#f59e0b', inkLight: '#0b0f14', border: 'solid',  pattern: null,     icon: 'pause',     family: 'paused', severity: 3, producing: false, outlineLight: true },
  SETUP:       { word: 'SETUP',      label: 'Setup',          fill: '#b69cff', ink: '#0b0f14', fillLight: '#a78bfa', inkLight: '#0b0f14', border: 'solid',  pattern: null,     icon: 'wrench',    family: 'setup',  severity: 1, producing: false, outlineLight: true },
  IDLE:        { word: 'IDLE',       label: 'Idle',           fill: '#2f6fde', ink: '#ffffff', fillLight: '#1d5fc4', inkLight: '#ffffff', border: 'solid',  pattern: null,     icon: 'circle',    family: 'idle',   severity: 1, producing: false },
  RUNNING:     { word: 'RUNNING',    label: 'Running',        fill: '#12b886', ink: '#0b0f14', fillLight: '#0f9f77', inkLight: '#0b0f14', border: 'solid',  pattern: null,     icon: 'play',      family: 'running', severity: 0, producing: true },
  UNAVAILABLE: { word: 'NO DATA',    label: 'No data',        fill: '#55606e', ink: '#ffffff', fillLight: '#cbd2da', inkLight: '#0b0f14', border: 'dashed', pattern: 'hatch',  icon: 'unplugged', family: 'nodata', severity: 2, producing: false, borderColor: '#9aa5b4', borderColorLight: '#6b7280' },
  OFFLINE:     { word: 'OFFLINE',    label: 'Offline',        fill: '#55606e', ink: '#ffffff', fillLight: '#cbd2da', inkLight: '#0b0f14', border: 'dashed', pattern: 'hatch',  icon: 'unplugged', family: 'nodata', severity: 2, producing: false, borderColor: '#9aa5b4', borderColorLight: '#6b7280' },
  UNBOUND:     { word: 'NOT LINKED', label: 'Not linked',     fill: null,      ink: '#9aa5b4', fillLight: null,      inkLight: '#6b7280', border: 'dashed', pattern: null,     icon: 'link-off',  family: null,     severity: 0, producing: false, borderColor: '#5b6573', borderColorLight: '#9aa5b4' },
});

/** Attention ring colours (D3) — hue-independent cue drawn outside a tile. */
export const ATTENTION_RING = Object.freeze({ dark: '#ffffff', light: '#0b0f14' });

/** E-stop hazard stripe colours (ISO 13850 yellow/black). */
export const HAZARD_COLORS = Object.freeze({ yellow: '#ffd400', black: '#0b0f14' });

// ---------------------------------------------------------------------------------------------
// Layout vocabulary (docs/LAYOUTS.md). Unknown kinds are allowed and rendered generically.
// ---------------------------------------------------------------------------------------------

/** Layout collections in render order (bottom → top). */
export const LAYOUT_COLLECTIONS = Object.freeze(['rooms', 'walls', 'doors', 'objects', 'labels', 'machines']);

/** Item kind as exposed on SVG groups via data-kind. */
export const ITEM_KIND_BY_COLLECTION = Object.freeze({
  rooms: 'room', walls: 'wall', doors: 'door', objects: 'object', labels: 'label', machines: 'machine',
});

export const MACHINE_KINDS = Object.freeze({
  '3-axis':     { label: '3-Axis Mill' },
  '4-axis':     { label: '4-Axis Mill' },
  '5-axis':     { label: '5-Axis Mill' },
  'mill-turn':  { label: 'Mill-Turn' },
  'lathe':      { label: 'Lathe' },
  'edm':        { label: 'EDM' },
  'wire-edm':   { label: 'Wire EDM' },
  'sinker-edm': { label: 'Sinker EDM' },
  'grinder':    { label: 'Grinder' },
  'router':     { label: 'Router' },
  'other':      { label: 'Machine' },
});

export const WALL_STYLES = Object.freeze({
  exterior:  { label: 'Exterior wall', defaultThickness: 0.75 },
  interior:  { label: 'Interior wall', defaultThickness: 0.4 },
  partition: { label: 'Partition / half wall', defaultThickness: 0.25 },
  former:    { label: 'Former wall line (dashed)', defaultThickness: 0.2 },
});

export const DOOR_KINDS = Object.freeze({
  door:     { label: 'Door' },
  double:   { label: 'Double door' },
  rollup:   { label: 'Roll-up / overhead door' },
  opening:  { label: 'Opening' },
  entrance: { label: 'Main entrance' },
});

export const ROOM_KINDS = Object.freeze({
  shop:      { label: 'Shop floor' },
  office:    { label: 'Office' },
  inventory: { label: 'Inventory' },
  shipping:  { label: 'Shipping / Receiving' },
  storage:   { label: 'Storage' },
  restroom:  { label: 'Restroom' },
  kitchen:   { label: 'Kitchen / break' },
  hallway:   { label: 'Hallway' },
  utility:   { label: 'Utility' },
  other:     { label: 'Room' },
});

export const OBJECT_KINDS = Object.freeze({
  rack:       { label: 'Rack' },
  shelving:   { label: 'Shelving' },
  bench:      { label: 'Workbench' },
  table:      { label: 'Table' },
  desk:       { label: 'Desk' },
  cabinet:    { label: 'Cabinet' },
  'tool-crib':{ label: 'Tool crib' },
  stairs:     { label: 'Stairs' },
  compressor: { label: 'Air compressor' },
  saw:        { label: 'Saw' },
  inspection: { label: 'Inspection / CMM' },
  washer:     { label: 'Parts washer' },
  fixture:    { label: 'Fixture / plumbing' },
  generic:    { label: 'Object' },
});

export const LABEL_STYLES = Object.freeze({
  title: { label: 'Title', size: 2.2 },
  room:  { label: 'Room label', size: 1.4 },
  note:  { label: 'Note', size: 1.0 },
  dim:   { label: 'Dimension', size: 0.9 },
});

/** Ids of individual layout items (unique within a layout). */
export const ITEM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Layout ids — also the file name (layouts/<id>.json). */
export const LAYOUT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

export const SSE_EVENTS = Object.freeze({
  SNAPSHOT: 'snapshot',
  MACHINE: 'machine',
  UNASSIGNED: 'unassigned',
  AGENTS: 'agents',
  LAYOUT: 'layout',
  DISCOVERY: 'discovery',
  SETTINGS: 'settings',   // public settings changed (src/server/api.js)
  RUNS: 'runs',           // a program run started, ended, changed or was (in)validated: { run } (DECISIONS D12)
  PING: 'ping',
  SHUTDOWN: 'shutdown',   // sent once when the server closes the stream ({ bootId })
});

/**
 * MachineSnapshot.connection values. 'degraded': the endpoint is failing (connectionError is set) but its last
 * successful exchange is younger than polling.offlineAfterMs, so the status is still the last known one (DECISIONS D1:
 * connection loss turns OFFLINE only after that grace). 'error' comes with status OFFLINE.
 */
export const SNAPSHOT_CONNECTION = Object.freeze({
  CONNECTED: 'connected',
  DEGRADED: 'degraded',
  CONNECTING: 'connecting',
  ERROR: 'error',
  UNBOUND: 'unbound',
});

/** History record kinds (src/machines/history.js). */
export const HISTORY_KINDS = Object.freeze({
  STATUS: 'status', CONDITION: 'condition', SERVICE: 'service', GAP: 'gap', SERVER: 'server',
});

/**
 * Human text for the fixed connection error classes (DECISIONS D7.7). Snapshots carry both:
 * `connectionError` = this text, `connectionErrorClass` = the class token. Unknown classes read "Connection error".
 */
/** UNAVAILABLE reasons that only mean the EXECUTION word was not understood (DECISIONS D1a): the display debounce
 *  holds RUNNING over them like a short PAUSED/IDLE/SETUP, so one poll of an unknown word does not grey the tile.
 *  Must equal REASONS.EXECUTION_UNKNOWN in src/mtconnect/vocabulary.js (checked by test/unit/vocabulary.test.js). */
export const DEBOUNCED_UNAVAILABLE_REASONS = Object.freeze(['Execution state unknown']);

export const ERROR_CLASS_TEXT = Object.freeze({
  CONNECT_REFUSED: 'Connection refused',
  TIMEOUT: 'Timed out',
  UNREACHABLE: 'Host unreachable',
  CONNECTION_RESET: 'Connection reset',
  RESET: 'Connection reset',
  DNS: 'Host name not found',
  TLS: 'TLS / certificate error',
  NOT_MTCONNECT: 'Not an MTConnect agent',
  TOO_LARGE: 'Response too large',
  REDIRECT: 'Redirect not allowed',
  PARSE: 'Unreadable response',
  PROTOCOL: 'Protocol error',
  AUTH: 'Login rejected',
  ADDRESS_NOT_ALLOWED: 'Address not allowed',
  POLICY: 'Address not allowed',
  UNSUPPORTED: 'Protocol not available',
  NO_DEVICE: 'Device not found on agent',
  ABORTED: 'Cancelled',
  NETWORK: 'Network error',
  STALE: 'No response',
  ERROR: 'Connection error',
});

/** Synonyms used by individual modules → the class exposed to clients. */
const ERROR_CLASS_ALIASES = Object.freeze({ RESET: 'CONNECTION_RESET', POLICY: 'ADDRESS_NOT_ALLOWED' });

/**
 * The class exposed to clients for an error class token (aliases folded: RESET → CONNECTION_RESET,
 * POLICY → ADDRESS_NOT_ALLOWED); null for no class.
 * @param {string|null|undefined} cls
 * @returns {string|null}
 */
export function canonicalErrorClass(cls) {
  if (cls === null || cls === undefined || cls === '') return null;
  const c = String(cls);
  return Object.prototype.hasOwnProperty.call(ERROR_CLASS_ALIASES, c) ? ERROR_CLASS_ALIASES[c] : c;
}

/**
 * Text for an error class ("HTTP_503" → "HTTP 503"); '' for no class.
 * @param {string|null|undefined} cls
 * @returns {string}
 */
export function errorClassText(cls) {
  if (cls === null || cls === undefined || cls === '') return '';
  const c = String(cls);
  if (Object.prototype.hasOwnProperty.call(ERROR_CLASS_TEXT, c)) return ERROR_CLASS_TEXT[c];
  if (/^HTTP_\d{3}$/.test(c)) return `HTTP ${c.slice(5)}`;
  return ERROR_CLASS_TEXT.ERROR;
}

// ---------------------------------------------------------------------------------------------
// JSDoc typedefs (documentation only — the shapes are normative, see docs/ARCHITECTURE.md)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {'ESTOP'|'ALARM'|'PAUSED'|'SETUP'|'IDLE'|'RUNNING'|'UNAVAILABLE'|'OFFLINE'|'UNBOUND'} Status
 * @typedef {'connected'|'degraded'|'connecting'|'error'|'unbound'} SnapshotConnection
 *
 * @typedef {Object} Observation
 * @property {string} deviceUuid
 * @property {string} deviceName
 * @property {string} componentId
 * @property {string} componentType
 * @property {string} componentName
 * @property {'SAMPLE'|'EVENT'|'CONDITION'} category
 * @property {string} element
 * @property {string} dataItemId
 * @property {string} [name]
 * @property {string} type
 * @property {string} [subType]
 * @property {string} [compositionId]
 * @property {string} timestamp
 * @property {number} sequence
 * @property {string|number|number[]|Object|null} value
 * @property {boolean} unavailable
 * @property {Object<string,string>} attrs
 * @property {'NORMAL'|'WARNING'|'FAULT'|'UNAVAILABLE'} [level]
 * @property {string} [nativeCode]
 * @property {string} [nativeSeverity]
 * @property {string} [qualifier]
 * @property {string} [conditionId]
 * @property {string} [message]
 * @property {boolean} [extension]
 *
 * @typedef {Object} DataItemDef
 * @property {string} id
 * @property {string} [name]
 * @property {string} type
 * @property {string} [subType]
 * @property {'SAMPLE'|'EVENT'|'CONDITION'} category
 * @property {string} [units]
 * @property {string} [nativeUnits]
 * @property {string} [representation]
 * @property {boolean} [discrete]
 * @property {string} componentId
 * @property {string} componentType
 * @property {string} [componentName]
 * @property {string} componentPath
 *
 * @typedef {Object} DeviceModel
 * @property {string} id
 * @property {string} name
 * @property {string|null} uuid       null when the probe has no uuid (never synthesized, DECISIONS D6)
 * @property {boolean} isAgent
 * @property {string} [mtconnectVersion]
 * @property {{manufacturer?:string, model?:string, serialNumber?:string, station?:string, text?:string}} description
 * @property {DataItemDef[]} dataItems
 * @property {Object<string, DataItemDef>} dataItemsById
 * @property {{linear:string[], rotary:string[], spindles:string[]}} axes
 * @property {string} inferredKind
 * @property {string} inferredKindReason
 * @property {Object} components
 * @property {AdapterDef[]} adapters             every Adapter component in the element's tree (MTConnect 1.7+); [] if none
 * @property {RelationshipRef[]} relationships   the element's own Configuration/Relationships; [] if none
 *
 * @typedef {Object} AdapterDef         an Adapter component (MTConnect 1.7+; src/mtconnect/deviceModel.js)
 * @property {string} id
 * @property {string|null} name            cppagent: the adapter URI ("shdr://okuma:7878")
 * @property {string|null} uri             ADAPTER_URI constraint value, else the name
 * @property {string|null} connectionStatusId  its CONNECTION_STATUS data item id
 * @property {string} componentPath
 * @property {RelationshipRef[]} relationships  from the Adapter's own Configuration/Relationships
 *
 * @typedef {Object} RelationshipRef   a ComponentRelationship / DeviceRelationship of a Configuration (MTConnect 1.7+)
 * @property {'component'|'device'} kind
 * @property {string|null} idRef           ComponentRelationship@idRef, or DeviceRelationship@idRef
 * @property {string|null} deviceUuidRef   DeviceRelationship@deviceUuidRef
 * @property {string|null} type            PARENT | CHILD | PEER
 * @property {string|null} role            DeviceRelationship@role (SYSTEM | AUXILIARY)
 *
 * @typedef {Object} DeviceSummary
 * @property {string} agent            base URL of the agent serving it
 * @property {string} name
 * @property {string|null} uuid       null when the probe has no uuid (DECISIONS D6)
 * @property {string} id
 * @property {string} [manufacturer]
 * @property {string} [model]
 * @property {string} [serialNumber]
 * @property {string} [mtconnectVersion]
 * @property {string} inferredKind
 * @property {{linear:string[], rotary:string[], spindles:string[]}} axes
 *
 * @typedef {Object} AgentState
 * @property {string} baseUrl
 * @property {'idle'|'connecting'|'connected'|'error'} status
 * @property {string|null} error
 * @property {string} [instanceId]
 * @property {string} [sender]
 * @property {string} [version]
 * @property {number|null} lastSuccessAt
 * @property {number|null} latencyMs
 * @property {number} clockOffsetMs
 * @property {number} consecutiveFailures
 *
 * @typedef {Object} ActiveCondition
 * @property {'WARNING'|'FAULT'} level
 * @property {string} [type]
 * @property {string} [nativeCode]
 * @property {string} [nativeSeverity]
 * @property {string} [qualifier]
 * @property {string} message
 * @property {number} since           server-clock ms
 * @property {string} dataItemId
 * @property {string} [componentName]
 *
 * @typedef {Object} MachineSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} kind
 * @property {{agent:string|null, device:string|null, resolved:boolean, deviceUuid:string|null, deviceName:string|null}} binding
 * @property {SnapshotConnection} connection  see SNAPSHOT_CONNECTION; 'degraded' = failing within offlineAfterMs
 * @property {string|null} connectionError       human text of the connection error ("Connection refused"), or null
 * @property {string|null} connectionErrorClass  its fixed class (CONNECT_REFUSED, TIMEOUT, HTTP_503, …), or null
 * @property {Status} status
 * @property {string} reason
 * @property {number|null} since
 * @property {number|null} stoppedSince
 * @property {number|null} lastRunningAt
 * @property {boolean} sinceIsLowerBound          anchor came from a cold-start /current → render "≥"
 * @property {boolean} stoppedSinceIsLowerBound
 * @property {'fault'|'warning'|null} badge        active-condition badge (attention rings are computed by src/shared/attention.js)
 * @property {{since:number, until:number|null, note:string}|null} service   planned downtime (D1)
 * @property {Object<string, string|number|null>} values
 * @property {ActiveCondition[]} conditions
 * @property {Object|null} device
 * @property {number} updatedAt
 *
 * @typedef {Object} DiscoveryResult
 * @property {number} startedAt
 * @property {number} finishedAt
 * @property {number} durationMs
 * @property {{cidr:string, hosts:number, iface?:string}[]} networks
 * @property {number[]} ports
 * @property {number} hostsScanned
 * @property {{baseUrl:string, host:string, port:number, sender?:string, version?:string, instanceId?:string, devices:DeviceSummary[]}[]} agents
 * @property {{host:string, port:number, banner?:string}[]} adapters
 * @property {{target:string, error:string}[]} errors
 *
 * @typedef {Object} LayoutRect
 * @property {string} id
 * @property {number} x  top-left of the unrotated rectangle (layout units)
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} [rotation]  degrees clockwise about the rectangle centre
 *
 * @typedef {Object} Layout
 * @property {string} schema   LAYOUT_SCHEMA
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {'ft'|'m'} units
 * @property {number} width
 * @property {number} height
 * @property {number} [grid]
 * @property {Object} [background]
 * @property {Object[]} walls
 * @property {Object[]} doors
 * @property {Object[]} rooms
 * @property {Object[]} objects
 * @property {Object[]} labels
 * @property {Object[]} machines
 */

