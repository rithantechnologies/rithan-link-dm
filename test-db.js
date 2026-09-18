require("dotenv").config();

const pool = require("./db");

async function main() {
  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS user,
        NOW() AS server_time
    `);

    console.log("PostgreSQL connected:");
    console.log(result.rows[0]);
  } catch (error) {
    console.error("PostgreSQL connection failed:");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
