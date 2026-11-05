const fs = require("fs");

// Persistence for the app.
//
// Postgres (Neon) is used whenever DATABASE_URL is set, which is what keeps
// accounts alive across restarts and redeploys. Without DATABASE_URL the app
// falls back to the original single JSON file so it still runs locally.

const USER_COLUMNS = "id, email, role, full_name, unit, salt_hex, password_hash, created_at";

function duplicateEmailError() {
  const err = new Error("That email is already registered.");
  err.code = "DUPLICATE_EMAIL";
  return err;
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    fullName: row.full_name,
    unit: row.unit,
    saltHex: row.salt_hex,
    passwordHash: row.password_hash,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function createJsonStorage({ dataDir, dbPath }) {
  const ensureDir = () => {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  };

  const read = () => {
    ensureDir();
    if (!fs.existsSync(dbPath)) return { users: [] };
    return JSON.parse(fs.readFileSync(dbPath, "utf8"));
  };

  const write = (db) => {
    ensureDir();
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
  };

  return {
    backendName: "json-file",
    async init({ seedUsers = [] } = {}) {
      const db = read();
      let changed = !fs.existsSync(dbPath);
      seedUsers.forEach((user) => {
        if (db.users.some((u) => u.email === user.email)) return;
        db.users.push(user);
        changed = true;
      });
      if (changed) write(db);
    },
    async findUserByEmail(email) {
      return read().users.find((u) => u.email === email) || null;
    },
    async findUserById(id) {
      return read().users.find((u) => u.id === id) || null;
    },
    async listUsers() {
      return read().users;
    },
    async insertUser(user) {
      const db = read();
      if (db.users.some((u) => u.email === user.email)) throw duplicateEmailError();
      db.users.push(user);
      write(db);
      return user;
    },
  };
}

function createPgStorage({ connectionString }) {
  const { Pool } = require("pg");
  const isLocal = /^postgres(ql)?:\/\/[^/@]*@?(localhost|127\.0\.0\.1)[:/]/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: isLocal || /sslmode=disable/.test(connectionString) ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  pool.on("error", (err) => console.error("Postgres pool error:", err.message));

  return {
    backendName: "postgres",
    async init({ seedUsers = [] } = {}) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          role TEXT NOT NULL,
          full_name TEXT NOT NULL DEFAULT '',
          unit TEXT NOT NULL DEFAULT '',
          salt_hex TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      for (const user of seedUsers) {
        await pool.query(
          `INSERT INTO users (id, email, role, full_name, unit, salt_hex, password_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (email) DO NOTHING`,
          [
            user.id,
            user.email,
            user.role,
            user.fullName,
            user.unit,
            user.saltHex,
            user.passwordHash,
            user.createdAt,
          ]
        );
      }
    },
    async findUserByEmail(email) {
      const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1 LIMIT 1`, [email]);
      return res.rows[0] ? rowToUser(res.rows[0]) : null;
    },
    async findUserById(id) {
      const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [id]);
      return res.rows[0] ? rowToUser(res.rows[0]) : null;
    },
    async listUsers() {
      const res = await pool.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`);
      return res.rows.map(rowToUser);
    },
    async insertUser(user) {
      const res = await pool.query(
        `INSERT INTO users (id, email, role, full_name, unit, salt_hex, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (email) DO NOTHING
         RETURNING ${USER_COLUMNS}`,
        [user.id, user.email, user.role, user.fullName, user.unit, user.saltHex, user.passwordHash, user.createdAt]
      );
      if (res.rowCount === 0) throw duplicateEmailError();
      return rowToUser(res.rows[0]);
    },
  };
}

function createStorage({ dataDir, dbPath, connectionString }) {
  const url = String(connectionString || "").trim();
  return url ? createPgStorage({ connectionString: url }) : createJsonStorage({ dataDir, dbPath });
}

module.exports = { createStorage };
