// §3: app-generated UUIDv7 primary keys on every table (except plans' text
// code PK, F9). The DB has no default — the app supplies ids.
export { v7 as uuidv7 } from "uuid";
