'use strict';
const { mkdirSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const samples = [
    { name: 'Canon-EOS-R.CR3', id: 4611, hash: 'cfd118af4477ef37538eb953421572a7a5c80694e59764049223107cc0c9ae83' },
    { name: 'Canon-EOS-M50-CRAW.CR3', id: 2663, hash: '15384b775867ec4c42b11882837f1e368cedc0561832ffab271221e6bb80be4c' },
];
(async () => {
    // Both entries in https://raw.pixls.us/json/getrepository.php are CC0.
    // Fixtures are opt-in, ignored by git, and never bundled with ABEL.
    const directory = '.azure-tools/raw-validation';
    mkdirSync(directory, { recursive: true });
    for (const sample of samples) {
        const response = await fetch(`https://raw.pixls.us/getfile.php/${sample.id}/nice/${sample.name}`);
        if (!response.ok) throw new Error(`Sample download failed (${response.status})`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== sample.hash) throw new Error(`Sample checksum mismatch: ${sample.name}`);
        writeFileSync(`${directory}/${sample.name}`, bytes);
        console.log(`Verified CC0 sample #${sample.id}: ${sample.name}`);
    }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
