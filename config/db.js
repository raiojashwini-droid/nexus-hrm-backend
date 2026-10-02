const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 30,
    maxIdle: 5,
    idleTimeout: 10000,       // 10s — reap idle connections before Railway kills them
    queueLimit: 0,
    timezone: '+05:30',
    dateStrings: true,
    enableKeepAlive: true,    // Prevent OS-level TCP connection drops
    keepAliveInitialDelay: 10000  // Start keep-alive pings after 10s of idle
});

// Periodic health-check: ping the pool every 30s to keep connections alive
setInterval(() => {
    pool.query('SELECT 1', (err) => {
        if (err) console.error('DB keep-alive ping failed:', err.message);
    });
}, 30000);

module.exports = pool.promise();
