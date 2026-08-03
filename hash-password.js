// Usage: node hash-password.js "YourStrongPassword"
// Copy the printed hash into ADMIN_PASSWORD_HASH in your .env file.

const bcrypt = require('bcryptjs');

const plain = process.argv[2];
if (!plain) {
  console.error('Usage: node hash-password.js "YourStrongPassword"');
  process.exit(1);
}

const hash = bcrypt.hashSync(plain, 12);
console.log('\nAdd this line to your .env file:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
