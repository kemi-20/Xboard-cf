import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import initSqlJs from "sql.js";

const source = fs.readFileSync("src/index.ts", "utf8");

test("balance-sensitive routes use state-guarded writes", () => {
  assert.match(source, /UPDATE v2_order SET status=1,paid_at=\?,callback_no='manual_operation'.*status=0 RETURNING id/);
  assert.match(source, /balance=COALESCE\(balance,0\)\+\?/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM v2_order WHERE user_id=u\.id AND status IN \(0,1\)\)/);
  assert.match(source, /SELECT balance_amount FROM v2_order WHERE trade_no=\?/);
  assert.match(source, /results\.at\(-1\).*changes/);
});

test("order balance reservation and cancellation are idempotent", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE v2_user(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, updated_at INTEGER)");
  db.run("CREATE TABLE v2_order(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,trade_no TEXT,status INTEGER,total_amount INTEGER,balance_amount INTEGER,updated_at INTEGER)");
  db.run("INSERT INTO v2_user VALUES (1,1000,0)");

  const reserve = tradeNo => {
    db.run(`INSERT INTO v2_order(user_id,trade_no,status,total_amount,balance_amount,updated_at)
      SELECT 1,?,0,MAX(0,?-MIN(MAX(COALESCE(u.balance,0),0),?)),MIN(MAX(COALESCE(u.balance,0),0),?),1
      FROM v2_user u WHERE u.id=1 AND NOT EXISTS (SELECT 1 FROM v2_order WHERE user_id=u.id AND status IN (0,1))`, [tradeNo, 700, 700, 700]);
    const inserted = db.getRowsModified();
    db.run(`UPDATE v2_user SET balance=balance-(SELECT balance_amount FROM v2_order WHERE trade_no=?),updated_at=1
      WHERE id=1 AND EXISTS (SELECT 1 FROM v2_order WHERE trade_no=? AND user_id=1 AND status=0) AND (SELECT balance_amount FROM v2_order WHERE trade_no=?)>0`, [tradeNo, tradeNo, tradeNo]);
    return inserted;
  };

  assert.equal(reserve("first"), 1);
  assert.deepEqual(db.exec("SELECT balance FROM v2_user")[0].values[0], [300]);
  assert.deepEqual(db.exec("SELECT total_amount,balance_amount FROM v2_order WHERE trade_no='first'")[0].values[0], [0, 700]);
  assert.equal(reserve("second"), 0);
  assert.equal(db.exec("SELECT COUNT(*) FROM v2_order")[0].values[0][0], 1);
  assert.equal(db.exec("SELECT balance FROM v2_user")[0].values[0][0], 300);

  const cancel = () => {
    db.run("BEGIN");
    db.run("UPDATE v2_user SET balance=balance+COALESCE((SELECT balance_amount FROM v2_order WHERE trade_no='first' AND status=0),0) WHERE id=1");
    db.run("UPDATE v2_order SET status=2 WHERE trade_no='first' AND status=0");
    const changed = db.getRowsModified();
    db.run("COMMIT");
    return changed;
  };
  assert.equal(cancel(), 1);
  assert.equal(cancel(), 0);
  assert.equal(db.exec("SELECT balance FROM v2_user")[0].values[0][0], 1000);
});

test("surplus credit settlement can only change balance once", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE v2_user(id INTEGER PRIMARY KEY,balance INTEGER NOT NULL)");
  db.run("CREATE TABLE v2_order(id INTEGER PRIMARY KEY,status INTEGER,surplus_credit INTEGER)");
  db.run("INSERT INTO v2_user VALUES (1,1000)");
  db.run("INSERT INTO v2_order VALUES (10,3,0),(11,1,200)");
  const settle = () => {
    db.run("BEGIN");
    db.run("UPDATE v2_order SET status=4 WHERE id=10 AND EXISTS (SELECT 1 FROM v2_order WHERE id=11 AND status=1)");
    db.run("UPDATE v2_user SET balance=balance+200 WHERE id=1 AND EXISTS (SELECT 1 FROM v2_order WHERE id=11 AND status=1)");
    db.run("UPDATE v2_order SET status=3 WHERE id=11 AND status=1");
    const changed = db.getRowsModified();
    db.run("COMMIT");
    return changed;
  };
  assert.equal(settle(), 1);
  assert.equal(settle(), 0);
  assert.equal(db.exec("SELECT balance FROM v2_user")[0].values[0][0], 1200);
  assert.equal(db.exec("SELECT status FROM v2_order WHERE id=10")[0].values[0][0], 4);
});
