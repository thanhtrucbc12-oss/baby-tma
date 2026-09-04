import fs from 'node:fs/promises';
await fs.mkdir('dist-site', { recursive: true });
for (const name of await fs.readdir('.')) {
  if (/\.(html|css|js|png|webmanifest)$/.test(name)) await fs.copyFile(name,'dist-site/'+name);
}
await fs.writeFile('dist-site/.nojekyll','');
