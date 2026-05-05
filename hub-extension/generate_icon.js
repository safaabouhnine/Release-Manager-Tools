const { Jimp } = require('jimp');

async function createIcon() {
    const image = new Jimp({ width: 128, height: 128, color: 0x0078d4ff });
    await image.write('icon.png');
    console.log('icon.png créé : 128x128 ');
}

createIcon();