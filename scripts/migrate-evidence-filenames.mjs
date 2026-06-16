import { promises as fs } from 'node:fs';
import path from 'node:path';

function sanitizeEvidencePart(value) {
  let part = value || '';
  try {
    if (/^https?:\/\//i.test(part)) {
      const parsed = new URL(part);
      part = parsed.pathname || '/';
    }
  } catch (e) {
    // ignore
  }
  // strip query/hash
  const q = part.indexOf('?');
  const h = part.indexOf('#');
  const cut = [q, h].filter(i => i >= 0).sort((a,b) => a-b)[0];
  if (typeof cut === 'number') part = part.slice(0, cut);
  const routePart = part === '/' ? 'root' : String(part).replace(/^\/+/, '');
  return routePart.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'report';
}

function buildFileNameFromRecord(rec, seqIndex) {
  const sequence = String(seqIndex + 1).padStart(2, '0');
  const environmentPart = rec.environment && rec.environment.name ? `${sanitizeEvidencePart(rec.environment.name)}-` : (rec.environment ? `${sanitizeEvidencePart(String(rec.environment))}-` : '');
  const routePart = sanitizeEvidencePart(rec.route ?? rec.url ?? String(seqIndex));
  const formFactorPart = sanitizeEvidencePart(rec.formFactor ?? 'desktop');
  const runIndex = rec.runIndex ?? 1;
  return `lighthouse-${sequence}-${environmentPart}${routePart}-${formFactorPart}-run-${runIndex}.html`;
}

async function migrateJobs(root = '.lh-audit/jobs') {
  const absRoot = path.resolve(root);
  let entries;
  try {
    entries = await fs.readdir(absRoot, { withFileTypes: true });
  } catch (err) {
    console.error('No jobs directory found at', absRoot);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    const jobRoot = path.join(absRoot, jobId);
    const metaPath = path.join(jobRoot, 'meta.json');
    try {
      const metaRaw = await fs.readFile(metaPath, 'utf8');
      const meta = JSON.parse(metaRaw);
      const reports = Array.isArray(meta.evidence?.htmlReports) ? meta.evidence.htmlReports : [];
      if (!reports.length) continue;
      const evidenceDir = path.join(jobRoot, 'evidence');
      let indexContent = '';
      try { indexContent = await fs.readFile(path.join(evidenceDir, 'index.html'), 'utf8'); } catch {}

      let changed = false;
      for (let i = 0; i < reports.length; i++) {
        const r = reports[i];
        const oldName = String(r.fileName || '');
        const newName = buildFileNameFromRecord(r, i);
        if (!oldName || oldName === newName) {
          // still set to newName if missing
          if (!oldName) { r.fileName = newName; changed = true; }
          continue;
        }

        const oldPath = path.join(evidenceDir, oldName);
        const newPath = path.join(evidenceDir, newName);
        let existsOld = false;
        try { await fs.access(oldPath); existsOld = true; } catch {}
        let existsNew = false;
        try { await fs.access(newPath); existsNew = true; } catch {}

        if (existsOld && !existsNew) {
          console.log(jobId, 'rename', oldName, '->', newName);
          await fs.rename(oldPath, newPath);
          r.fileName = newName;
          changed = true;

          // update index content replacements (both raw and encoded form)
          if (indexContent) {
            const encOld = encodeURIComponent(oldName);
            const encNew = encodeURIComponent(newName);
            indexContent = indexContent.split(oldName).join(newName);
            indexContent = indexContent.split(encOld).join(encNew);
          }
        } else if (!existsOld && existsNew) {
          // nothing to do; update meta if oldName missing
          console.log(jobId, 'old missing but new exists, updating meta:', newName);
          r.fileName = newName;
          changed = true;
        } else if (!existsOld && !existsNew) {
          // nothing to rename; but update meta to newName so future UI links match
          console.log(jobId, 'neither old nor new exist for', oldName, '->', newName, ', updating meta only');
          r.fileName = newName;
          changed = true;
        } else if (existsOld && existsNew) {
          // both exist - avoid overwriting; skip but update meta to newName
          console.log(jobId, 'both old and new exist for', oldName, ', keeping both and updating meta to', newName);
          r.fileName = newName;
          changed = true;
        }
      }

      if (changed) {
        // write back meta.json
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
        if (indexContent) {
          await fs.writeFile(path.join(evidenceDir, 'index.html'), indexContent, 'utf8');
        }
        console.log('updated meta for job', jobId);
      }
    } catch (err) {
      // skip jobs without meta
    }
  }
}

migrateJobs().catch((err) => { console.error(err); process.exit(1); });
