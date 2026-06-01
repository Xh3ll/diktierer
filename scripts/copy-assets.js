const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dst = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(dst, { recursive: true });

for (const file of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(src, file), path.join(dst, file));
}

console.log('Assets kopiert: index.html, styles.css → dist/renderer/');
