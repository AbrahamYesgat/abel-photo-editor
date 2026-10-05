'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const fixtures = [
    { name: 'Fronalpstock.jpg', url: 'https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg',
        sha256: '24eb29eccdf0af691b406d1a3d22c0ef5d761cc454d8a917848c33958f6fc857',
        credit: 'Hannes Röst, Fronalpstock big, CC BY-SA 3.0',
        source: 'https://commons.wikimedia.org/wiki/File:Fronalpstock_big.jpg',
        license: 'https://creativecommons.org/licenses/by-sa/3.0/' },
    { name: 'Sally-Ride.jpg', url: 'https://upload.wikimedia.org/wikipedia/commons/c/c2/Sally_Ride_in_1984.jpg',
        sha256: '06f47e7411e6d6af706f8206f648e56576f31f11c6970596cdd128a5bda009c0',
        credit: 'NASA, Sally Ride in 1984; dust/scratch retouch by Adam Cuerden. Public domain.',
        source: 'https://commons.wikimedia.org/wiki/File:Sally_Ride_in_1984.jpg',
        license: 'Public domain (US federal government work)' },
    { name: 'Golden-retriever.jpg', url: 'https://upload.wikimedia.org/wikipedia/commons/a/af/Golden_retriever_eating_pigs_foot.jpg',
        sha256: 'f53cec5dc23d10d91500c50d79ccb4e73df697f64fc2cd93a1b2fcf2698775c5',
        credit: 'Denhulde, Golden retriever eating pigs foot, CC BY-SA 3.0',
        source: 'https://commons.wikimedia.org/wiki/File:Golden_retriever_eating_pigs_foot.jpg',
        license: 'https://creativecommons.org/licenses/by-sa/3.0/' },
];
(async () => {
    const dir = '.azure-tools/semantic-validation';
    await fs.mkdir(dir, { recursive: true });
    for (const fixture of fixtures) {
        const response = await fetch(fixture.url);
        if (!response.ok) throw new Error(`Fixture download failed: ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== fixture.sha256) throw new Error(`Fixture changed: ${fixture.name}`);
        await fs.writeFile(`${dir}/${fixture.name}`, bytes);
        console.log(fixture.credit);
    }
    await fs.writeFile(`${dir}/credits.json`, JSON.stringify(fixtures, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
