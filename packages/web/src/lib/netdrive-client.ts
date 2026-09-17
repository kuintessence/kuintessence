import { type NetDriveListItem, NetDriveListItemSchema } from "@kuintessence/shared/browser";
import { api } from "./api-client";

export interface NetDriveListEnvelope {
  success: true;
  data: {
    files: NetDriveListItem[];
    total: number;
    limit?: number;
    offset?: number;
  };
}

const NETDRIVE_LIST_PAGE_SIZE = 500;
const NETDRIVE_LIST_STABILITY_ATTEMPTS = 3;
const NetDriveCapabilitiesSchema = NetDriveListItemSchema.pick({
  canUse: true,
  canDelete: true,
});

export async function listAllNetDriveFiles(): Promise<NetDriveListEnvelope> {
  for (let attempt = 0; attempt < NETDRIVE_LIST_STABILITY_ATTEMPTS; attempt += 1) {
    const current = await loadNetDriveFilePass();
    if (current) return current;
  }
  throw new Error("NetDrive file list changed while loading; retry the request");
}

async function loadNetDriveFilePass(): Promise<NetDriveListEnvelope | null> {
  const first = await api.get<NetDriveListEnvelope>("/netdrive/files");
  validateCapabilities(first.data.files);
  const expectedTotal = first.data.total;
  const files = [...first.data.files];
  if (files.length === expectedTotal) return normalizeEnvelope(first, files);
  const ids = new Set(files.map((file) => file.id));
  let offset = files.length;
  if (ids.size !== files.length) return null;
  while (offset < expectedTotal) {
    const page = await api.get<NetDriveListEnvelope>(
      `/netdrive/files?limit=${NETDRIVE_LIST_PAGE_SIZE}&offset=${offset}`,
    );
    validateCapabilities(page.data.files);
    if (page.data.total !== expectedTotal || page.data.files.length === 0) return null;
    for (const file of page.data.files) {
      if (ids.has(file.id)) return null;
      ids.add(file.id);
      files.push(file);
    }
    offset += page.data.files.length;
  }
  if (files.length !== expectedTotal) return null;
  const verification = await api.get<NetDriveListEnvelope>("/netdrive/files");
  validateCapabilities(verification.data.files);
  if (!sameFirstPage(first, verification)) return null;
  return normalizeEnvelope(first, files);
}

function validateCapabilities(files: NetDriveListItem[]): void {
  for (const file of files) {
    NetDriveCapabilitiesSchema.parse(file);
  }
}

function normalizeEnvelope(
  first: NetDriveListEnvelope,
  files: NetDriveListItem[],
): NetDriveListEnvelope {
  return {
    success: true,
    data: {
      ...first.data,
      files,
      limit: files.length,
      offset: 0,
    },
  };
}

function sameFirstPage(left: NetDriveListEnvelope, right: NetDriveListEnvelope): boolean {
  if (left.data.total !== right.data.total) return false;
  if (left.data.files.length !== right.data.files.length) return false;
  return left.data.files.every((file, index) => file.id === right.data.files[index]?.id);
}
