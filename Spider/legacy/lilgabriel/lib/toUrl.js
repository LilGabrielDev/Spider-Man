const axios = require('axios');
const FormData = require('form-data');

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input);
  throw new Error('Invalid media buffer for uploadToUrl.');
}

async function uploadToUrl(mediaInput, filename = 'upload.png') {
  const buffer = toBuffer(mediaInput);

  // Try Catbox first (supports images, video, audio, generic files), fallback to ImgBB.
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', buffer, { filename });
    const { data } = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 20000,
    });
    if (typeof data === 'string' && data.trim().startsWith('http')) {
      return data.trim();
    }
  } catch {
    // fallback to ImgBB below
  }

  const imgbbForm = new FormData();
  imgbbForm.append('image', buffer.toString('base64'));
  const imgbbKey = process.env.IMGBB_API_KEY || '8b468bac6311f8b2fd23d20e90186ac8';
  const { data } = await axios.post(
    `https://api.imgbb.com/1/upload?key=${encodeURIComponent(imgbbKey)}`,
    imgbbForm,
    {
      headers: imgbbForm.getHeaders(),
      timeout: 20000,
    },
  );
  const url = data?.data?.url;
  if (!url) throw new Error('Media upload failed.');
  return url;
}

module.exports = uploadToUrl;
module.exports.uploadToUrl = uploadToUrl;
module.exports.default = uploadToUrl;
