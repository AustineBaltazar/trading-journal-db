const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Credentials come from the default AWS chain: the EC2 instance role in
// production, env vars locally. S3_ENDPOINT points at MinIO for local testing.
const bucket = process.env.IMAGES_BUCKET;
const client = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-1",
  ...(process.env.S3_ENDPOINT
    ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
    : {}),
});

const UPLOAD_URL_SECONDS = 5 * 60;
const VIEW_URL_SECONDS = 15 * 60;

function imagesConfigured() {
  return Boolean(bucket);
}

// Signed PUT link; the browser must send exactly this Content-Type and size
function uploadUrl(key, contentType, size) {
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: UPLOAD_URL_SECONDS },
  );
}

function viewUrl(key) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: VIEW_URL_SECONDS,
  });
}

// Size and type of an uploaded object, or null if it isn't there
async function headObject(key) {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: head.ContentLength, contentType: head.ContentType };
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === "NotFound") return null;
    throw err;
  }
}

function deleteObject(key) {
  return client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

module.exports = { imagesConfigured, uploadUrl, viewUrl, headObject, deleteObject };
