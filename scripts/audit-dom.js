const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public');
const pages = ['index.html', 'student.html', 'admin.html'];

function extractIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\bid=["']([^"']+)["']/g)) ids.add(m[1]);
  return ids;
}

function extractGetById(code) {
  const ids = [];
  for (const m of code.matchAll(/getElementById\(["']([^"']+)["']\)/g)) ids.push(m[1]);
  return ids;
}

for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const ids = extractIds(html);
  const scripts = [...html.matchAll(/src=["']\/?(js\/[^"']+)["']/g)].map((m) => m[1]);
  let code = html
    .split(/<script(?![^>]*\bsrc=)[^>]*>/i)
    .slice(1)
    .map((s) => s.split('</script>')[0])
    .join('\n');
  for (const s of scripts) {
    const p = path.join(root, s);
    if (fs.existsSync(p)) code += `\n${fs.readFileSync(p, 'utf8')}`;
  }
  const needed = extractGetById(code);
  const missing = [...new Set(needed)].filter((id) => {
    if (ids.has(id)) return false;
    if (id.startsWith('tab-') && html.includes(`data-tab="${id.slice(4)}"`)) return false;
    return true;
  });
  console.log(`${page}: missing IDs -> ${missing.length ? missing.join(', ') : '(none)'}`);
}
