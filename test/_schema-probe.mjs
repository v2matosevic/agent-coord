// Open a fresh connection while a parent may hold the WAL writer lock.
import { DatabaseSync } from "node:sqlite";
const original = DatabaseSync.prototype.exec;
const writes = [];
DatabaseSync.prototype.exec = function (sql) {
  if (/\b(BEGIN IMMEDIATE|CREATE|ALTER|INSERT|UPDATE)\b/i.test(sql)) writes.push(sql);
  return original.call(this, sql);
};
const { getDb } = await import("../lib/store.mjs");
getDb();
console.log(JSON.stringify({ schemaWrites: writes.length }));
