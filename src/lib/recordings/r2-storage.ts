import "server-only";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const MULTIPART_THRESHOLD = 100 * MIB;
const MULTIPART_PART_SIZE = 64 * MIB;
const MAX_MULTIPART_PARTS = 1000;
const MAX_RECORDING_SIZE = 4 * 1024 ** 4;

type R2Settings = {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type CachedR2Client = R2Settings & { client: S3Client };

let cachedClient: CachedR2Client | null = null;

function readR2Settings(): R2Settings | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const bucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim();
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY?.trim();
  const values = [accountId, bucketName, accessKeyId, secretAccessKey];

  if (values.some((value) => !value || /^(your-|replace-)/i.test(value))) return null;
  return { accountId: accountId!, bucketName: bucketName!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! };
}

export function isR2StorageConfigured(): boolean {
  return readR2Settings() !== null;
}

export function getR2Storage() {
  const settings = readR2Settings();
  if (!settings) throw new Error("Cloudflare R2 is not configured.");

  if (
    !cachedClient ||
    cachedClient.accountId !== settings.accountId ||
    cachedClient.bucketName !== settings.bucketName ||
    cachedClient.accessKeyId !== settings.accessKeyId ||
    cachedClient.secretAccessKey !== settings.secretAccessKey
  ) {
    cachedClient?.client.destroy();
    const endpoint = "https://" + settings.accountId + ".r2.cloudflarestorage.com";
    cachedClient = {
      ...settings,
      client: new S3Client({
        region: "auto",
        endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
        },
        requestChecksumCalculation: "WHEN_REQUIRED",
      }),
    };
  }

  return { client: cachedClient.client, bucketName: settings.bucketName };
}

export type R2UploadSession =
  | { mode: "single"; uploadUrl: string }
  | { mode: "multipart"; uploadId: string; partSizeBytes: number; partUrls: string[] };

export async function createR2UploadSession(key: string, mimeType: string, sizeBytes: number): Promise<R2UploadSession> {
  const { client, bucketName } = getR2Storage();
  if (sizeBytes > MAX_RECORDING_SIZE) throw new Error("This video is larger than Cloudflare R2’s supported upload size.");

  if (sizeBytes <= MULTIPART_THRESHOLD) {
    const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: mimeType,
    }), { expiresIn: 60 * 60 });
    return { mode: "single", uploadUrl };
  }

  const partSizeBytes = Math.max(MULTIPART_PART_SIZE, Math.ceil(sizeBytes / MAX_MULTIPART_PARTS / MIB) * MIB);
  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  if (partCount > MAX_MULTIPART_PARTS || partSizeBytes > 5 * GIB) {
    throw new Error("This video is too large for the current upload flow.");
  }

  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: mimeType,
  }));
  if (!created.UploadId) throw new Error("Cloudflare R2 could not start the video upload.");

  try {
    const partUrls = await Promise.all(Array.from({ length: partCount }, (_, index) => getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucketName,
        Key: key,
        UploadId: created.UploadId,
        PartNumber: index + 1,
      }),
      { expiresIn: 24 * 60 * 60 },
    )));
    return { mode: "multipart", uploadId: created.UploadId, partSizeBytes, partUrls };
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucketName,
      Key: key,
      UploadId: created.UploadId,
    })).catch(() => undefined);
    throw error;
  }
}

export async function completeR2MultipartUpload(key: string, uploadId: string, expectedSizeBytes: number, partSizeBytes: number) {
  const { client, bucketName } = getR2Storage();
  const listed = await client.send(new ListPartsCommand({
    Bucket: bucketName,
    Key: key,
    UploadId: uploadId,
  }));
  const parts = (listed.Parts ?? [])
    .flatMap((part) => {
      if (typeof part.PartNumber !== "number" || typeof part.ETag !== "string" || typeof part.Size !== "number") {
        return [];
      }
      return [{ PartNumber: part.PartNumber, ETag: part.ETag, Size: part.Size }];
    })
    .sort((first, second) => first.PartNumber - second.PartNumber);
  const expectedPartCount = Math.ceil(expectedSizeBytes / partSizeBytes);
  const uploadedBytes = parts.reduce((total, part) => total + part.Size, 0);
  const partsAreSequential = parts.every((part, index) => part.PartNumber === index + 1);

  if (listed.IsTruncated || !partsAreSequential || parts.length !== expectedPartCount || uploadedBytes !== expectedSizeBytes) {
    throw new Error("The video upload is incomplete. Please try again.");
  }

  await client.send(new CompleteMultipartUploadCommand({
    Bucket: bucketName,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: parts.map((part) => ({ PartNumber: part.PartNumber, ETag: part.ETag })),
    },
  }));
}

export async function getR2ObjectMetadata(key: string) {
  const { client, bucketName } = getR2Storage();
  return client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
}

export async function getR2Object(key: string) {
  const { client, bucketName } = getR2Storage();
  return client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }));
}

export async function createR2DownloadUrl(key: string, mimeType: string): Promise<string> {
  const { client, bucketName } = getR2Storage();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
    ResponseContentType: mimeType,
    ResponseContentDisposition: "inline",
  }), { expiresIn: 7 * 24 * 60 * 60 });
}

export async function removeR2Upload(key: string, uploadId?: string) {
  const { client, bucketName } = getR2Storage();
  if (uploadId) {
    await client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: uploadId })).catch(() => undefined);
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}
