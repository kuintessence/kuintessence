import { type PgDb, platformBranding } from "@kuintessence/db";
import {
  EMPTY_PLATFORM_BRANDING,
  type PlatformBranding,
  PlatformBrandingSchema,
  type PlatformBrandingView,
  PlatformBrandingViewSchema,
} from "@kuintessence/shared";
import { eq } from "drizzle-orm";

const SINGLETON_ID = "default";

type BrandingDb = Pick<PgDb, "select">;

export async function loadPlatformBranding(db: BrandingDb): Promise<PlatformBrandingView> {
  const [row] = await db
    .select()
    .from(platformBranding)
    .where(eq(platformBranding.singletonId, SINGLETON_ID))
    .limit(1);
  if (!row) return emptyView();

  const parsed = PlatformBrandingSchema.safeParse({
    locales: row.locales,
    logoUrl: row.logoUrl,
    faviconUrl: row.faviconUrl,
  });
  if (!parsed.success) {
    return {
      ...emptyView(),
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedBy,
    };
  }
  return {
    ...parsed.data,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export async function savePlatformBranding(
  db: Pick<PgDb, "insert">,
  input: PlatformBranding,
  updatedBy: string,
): Promise<void> {
  const parsed = PlatformBrandingSchema.parse(input);
  const now = new Date();
  await db
    .insert(platformBranding)
    .values({
      singletonId: SINGLETON_ID,
      locales: parsed.locales,
      logoUrl: parsed.logoUrl,
      faviconUrl: parsed.faviconUrl,
      updatedAt: now,
      updatedBy,
    })
    .onConflictDoUpdate({
      target: platformBranding.singletonId,
      set: {
        locales: parsed.locales,
        logoUrl: parsed.logoUrl,
        faviconUrl: parsed.faviconUrl,
        updatedAt: now,
        updatedBy,
      },
    });
}

function emptyView(): PlatformBrandingView {
  return PlatformBrandingViewSchema.parse({
    ...structuredClone(EMPTY_PLATFORM_BRANDING),
    updatedAt: null,
    updatedBy: null,
  });
}
