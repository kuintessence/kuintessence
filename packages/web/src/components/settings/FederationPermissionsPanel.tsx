import {
  FederationCapabilityChangeSchema,
  type FederationCapabilityGrant,
  FederationCapabilityGrantSchema,
  FederationCapabilitySchema,
  FederationMemberOptionsSchema,
} from "@kuintessence/shared/federation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { type ReactNode, useDeferredValue, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { api } from "../../lib/api-client";
import { federationReadFailed } from "../../lib/federation-query-state";
import { useMobileMutationBlocked } from "../../lib/use-mobile-mutation-blocked";
import { toUserFacingError } from "../../lib/user-facing-error";
import {
  FederationRefreshNotice,
  FederationSectionTitle,
  useFederationAuthRevision,
} from "../federation/FederationLayout";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader } from "../ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

const root = "/admin/federation/capabilities";
const key = ["federation", "grants"] as const;
const pageSize = 20;
const OrganizationSchema = z.object({ id: z.uuid(), name: z.string() });
type Organization = z.infer<typeof OrganizationSchema>;
const DirectorySchema = z.object({
  data: z.object({ organizations: z.array(OrganizationSchema), moreOrganizations: z.boolean() }),
});

export function FederationPermissionsPanel() {
  const authRevision = useFederationAuthRevision();
  return <PermissionsPanel key={authRevision ?? "anonymous"} />;
}
function PermissionsPanel() {
  const authRevision = useFederationAuthRevision();
  const { t } = useTranslation();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const directory = useQuery({
    queryKey: [...key, "organizations", deferredSearch, authRevision],
    queryFn: async () =>
      DirectorySchema.parse(
        await api.get<unknown>(
          `/admin/authz/membership-options?${new URLSearchParams({ organization: deferredSearch })}`,
        ),
      ).data,
    enabled: !organization,
  });
  const organizations = directory.data?.organizations ?? [];
  return organization ? (
    <OrganizationGrants
      key={organization.id}
      organization={organization}
      onBack={() => setOrganization(null)}
    />
  ) : (
    <Card data-testid="federation-permissions-panel" aria-label={t("federation.permissions.title")}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <FederationSectionTitle title={t("federation.permissions.title")} />
        <Button
          size="sm"
          variant="outline"
          disabled={directory.isFetching}
          onClick={() => void directory.refetch()}
        >
          <RefreshCw className="h-4 w-4" />
          {t("federation.refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <FederationRefreshNotice query={directory} onRetry={() => void directory.refetch()} />
        <Input
          aria-label={t("federation.permissions.organizationSearch")}
          placeholder={t("federation.permissions.organizationSearch")}
          value={search}
          maxLength={200}
          onChange={(e) => setSearch(e.target.value)}
        />
        {directory.isPending ? (
          <p role="status">{t("federation.loading")}</p>
        ) : federationReadFailed(directory) || !directory.data ? (
          <p role="alert" className="text-sm text-status-failed">
            {toUserFacingError(directory.error, t("federation.loadFailed"))}
          </p>
        ) : organizations.length ? (
          <ul className="divide-y divide-border">
            {organizations.map((org) => (
              <li key={org.id}>
                <button
                  type="button"
                  disabled={directory.isFetching || search !== deferredSearch}
                  className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-4 text-left hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setOrganization(org)}
                >
                  <span className="min-w-0 break-words text-sm">
                    {org.name}
                    {organizations.filter((item) => item.name === org.name).length > 1 ? (
                      <code className="mt-1 block break-all text-xs text-muted-foreground">
                        {org.id}
                      </code>
                    ) : null}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("federation.permissions.noOrganizations")}
          </p>
        )}
        {!federationReadFailed(directory) && directory.data?.moreOrganizations ? (
          <p className="text-sm text-muted-foreground">
            {t("federation.permissions.refineSearch")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function OrganizationGrants({
  organization,
  onBack,
}: {
  organization: Organization;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const authRevision = useFederationAuthRevision();
  const client = useQueryClient();
  const mobileReadOnly = useMobileMutationBlocked(root);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<FederationCapabilityGrant | null>(null);
  const grants = useQuery({
    queryKey: [...key, organization.id, page, authRevision],
    queryFn: async () =>
      z
        .array(FederationCapabilityGrantSchema)
        .parse(
          (
            await api.get<{ data: unknown }>(
              `${root}?${new URLSearchParams({ orgId: organization.id, limit: String(pageSize), offset: String(page * pageSize) })}`,
            )
          ).data,
        ),
  });
  const mutation = useMutation({
    mutationFn: (input: z.infer<typeof FederationCapabilityChangeSchema>) => api.put(root, input),
    onSuccess: async () => {
      setAdding(false);
      setRevoking(null);
      await client.invalidateQueries({ queryKey: [...key, organization.id] });
      await client.invalidateQueries({ queryKey: ["federation", "current-capabilities"] });
    },
  });
  const disabled = mobileReadOnly || mutation.isPending || grants.isError || grants.isPending;
  const save = (input: z.infer<typeof FederationCapabilityChangeSchema>) => {
    if (disabled) return;
    mutation.mutate(input);
  };
  const failure = mutation.isError ? (
    <p role="alert" className="text-sm text-status-failed">
      {toUserFacingError(mutation.error, t("federation.saveFailed"))}
    </p>
  ) : null;
  return (
    <Card data-testid="federation-permissions-panel" aria-label={t("federation.permissions.title")}>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <FederationSectionTitle title={t("federation.permissions.title")} />
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={mutation.isPending || adding || grants.isFetching}
            onClick={() => void grants.refetch()}
          >
            <RefreshCw className="h-4 w-4" />
            {t("federation.refresh")}
          </Button>
          <Button
            size="sm"
            disabled={disabled || adding}
            onClick={() => {
              mutation.reset();
              setAdding(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t("federation.permissions.grant")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <FederationRefreshNotice query={grants} onRetry={() => void grants.refetch()} />
        <Button size="sm" variant="ghost" disabled={mutation.isPending || adding} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          {t("federation.permissions.back")}
        </Button>
        <div className="space-y-1">
          <h3 className="break-words text-base font-semibold">{organization.name}</h3>
          <code className="block break-all text-xs text-muted-foreground">{organization.id}</code>
        </div>
        {mobileReadOnly ? (
          <p className="text-sm text-muted-foreground">{t("federation.permissions.desktopOnly")}</p>
        ) : null}
        {adding && !mobileReadOnly && !federationReadFailed(grants) ? (
          <GrantForm
            organization={organization}
            busy={mutation.isPending}
            blocked={disabled}
            onSave={save}
            onCancel={() => {
              mutation.reset();
              setAdding(false);
            }}
            error={failure}
          />
        ) : null}
        {adding && federationReadFailed(grants) ? (
          <Button variant="ghost" disabled={mutation.isPending} onClick={() => setAdding(false)}>
            {t("federation.cancel")}
          </Button>
        ) : null}
        {grants.isPending ? (
          <p role="status">{t("federation.loading")}</p>
        ) : federationReadFailed(grants) || !grants.data ? (
          <p role="alert" className="text-sm text-status-failed">
            {toUserFacingError(grants.error, t("federation.loadFailed"))}
          </p>
        ) : grants.data.length ? (
          <ul className="divide-y divide-border">
            {grants.data.map((grant) => (
              <li
                key={`${grant.userId}:${grant.capability}`}
                className="flex flex-wrap items-start gap-3 py-4"
              >
                <div className="min-w-0 flex-1 basis-44 space-y-1">
                  <p className="break-words text-sm font-medium">
                    {grant.displayName || grant.email || grant.userId}
                  </p>
                  {grant.displayName && grant.email ? (
                    <p className="break-all text-xs text-muted-foreground">{grant.email}</p>
                  ) : null}
                  {grant.suspended || grant.serviceAccount || !grant.membershipActive ? (
                    <Badge variant="outline">{t("federation.permissions.ineligibleMember")}</Badge>
                  ) : null}
                </div>
                <div className="min-w-0 flex-1 basis-44 space-y-1">
                  <p className="text-sm">
                    {t(`federation.permissions.capabilities.${grant.capability}`)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(grant.grantedAt).toLocaleString(i18n.language)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled || adding}
                  onClick={() => {
                    mutation.reset();
                    setRevoking(grant);
                  }}
                >
                  {t("federation.permissions.remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("federation.permissions.noGrants")}</p>
        )}
        {!adding && !revoking ? failure : null}
        {!federationReadFailed(grants) &&
        grants.data &&
        (page > 0 || grants.data.length === pageSize) ? (
          <nav
            aria-label={t("federation.permissions.pagination")}
            className="flex items-center justify-end gap-3"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0 || grants.isFetching || mutation.isPending || adding}
              onClick={() => setPage(page - 1)}
            >
              {t("federation.previous")}
            </Button>
            <span className="text-sm tabular-nums">{page + 1}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={
                grants.data.length < pageSize || grants.isFetching || mutation.isPending || adding
              }
              onClick={() => setPage(page + 1)}
            >
              {t("federation.next")}
            </Button>
          </nav>
        ) : null}
        <Dialog
          open={!!revoking && !federationReadFailed(grants)}
          onOpenChange={(open) => {
            if (!open && !mutation.isPending) setRevoking(null);
          }}
        >
          <DialogContent dismissible={!mutation.isPending}>
            <DialogHeader>
              <DialogTitle>{t("federation.permissions.remove")}</DialogTitle>
              <DialogDescription>{t("federation.permissions.removeEffect")}</DialogDescription>
            </DialogHeader>
            <DialogBody className="space-y-2 text-sm">
              <p>{organization.name}</p>
              <p className="break-all">
                {revoking?.displayName || revoking?.email || revoking?.userId}
              </p>
              {revoking?.displayName && revoking.email ? (
                <p className="break-all text-muted-foreground">{revoking.email}</p>
              ) : null}
              <p>
                {revoking ? t(`federation.permissions.capabilities.${revoking.capability}`) : ""}
              </p>
              {failure}
            </DialogBody>
            <DialogFooter className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => setRevoking(null)}
              >
                {t("federation.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  if (revoking)
                    save({
                      orgId: organization.id,
                      userId: revoking.userId,
                      capability: revoking.capability,
                      enabled: false,
                    });
                }}
              >
                {t(mutation.isPending ? "federation.saving" : "federation.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function GrantForm({
  organization,
  busy,
  blocked,
  onSave,
  onCancel,
  error,
}: {
  organization: Organization;
  busy: boolean;
  blocked: boolean;
  onSave: (input: z.infer<typeof FederationCapabilityChangeSchema>) => void;
  onCancel: () => void;
  error: ReactNode;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(0);
  const [member, setMember] = useState<{
    userId: string;
    email: string;
    displayName: string | null;
  } | null>(null);
  const [capability, setCapability] = useState("");
  const authRevision = useFederationAuthRevision();
  const members = useQuery({
    queryKey: [...key, organization.id, "members", deferredSearch, page, authRevision],
    queryFn: async () =>
      FederationMemberOptionsSchema.parse(
        await api.get<unknown>(
          `${root}/members?${new URLSearchParams({ orgId: organization.id, search: deferredSearch, limit: String(pageSize), offset: String(page * pageSize) })}`,
        ),
      ),
  });
  return (
    <form
      className="space-y-4 border-y border-border py-5"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = FederationCapabilityChangeSchema.safeParse({
          orgId: organization.id,
          userId: member?.userId,
          capability,
          enabled: true,
        });
        if (!blocked && parsed.success) onSave(parsed.data);
      }}
    >
      <h4 className="text-sm font-semibold">{t("federation.permissions.grant")}</h4>
      <fieldset disabled={blocked} className="space-y-4">
        {member ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 break-all text-sm">
              {member.displayName || member.email}
              {member.displayName ? ` (${member.email})` : ""}
            </p>
            <Button variant="outline" size="sm" type="button" onClick={() => setMember(null)}>
              {t("federation.permissions.changeMember")}
            </Button>
          </div>
        ) : (
          <>
            <Input
              aria-label={t("federation.permissions.memberSearch")}
              placeholder={t("federation.permissions.memberSearch")}
              maxLength={200}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            <FederationRefreshNotice query={members} onRetry={() => void members.refetch()} />
            {members.isPending ? (
              <p role="status">{t("federation.loading")}</p>
            ) : federationReadFailed(members) || !members.data ? (
              <p role="alert" className="text-sm text-status-failed">
                {toUserFacingError(members.error, t("federation.loadFailed"))}
              </p>
            ) : members.data.data.length ? (
              <ul className="max-h-64 divide-y divide-border overflow-auto">
                {members.data.data.map((person) => (
                  <li key={person.userId}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto w-full justify-start whitespace-normal py-3 text-left"
                      disabled={members.isFetching || search !== deferredSearch}
                      onClick={() => setMember(person)}
                    >
                      <span className="break-all">
                        {person.displayName || person.email}
                        {person.displayName ? ` (${person.email})` : ""}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("federation.permissions.noMembers")}
              </p>
            )}
            {!federationReadFailed(members) &&
            members.data &&
            (page > 0 || members.data.hasMore) ? (
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page === 0 || members.isFetching}
                  onClick={() => setPage(page - 1)}
                >
                  {t("federation.previous")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!members.data.hasMore || members.isFetching}
                  onClick={() => setPage(page + 1)}
                >
                  {t("federation.next")}
                </Button>
              </div>
            ) : null}
          </>
        )}
        <div className="space-y-1 text-sm">
          <label htmlFor={`${fieldId}-capability`}>{t("federation.permissions.capability")}</label>
          <select
            id={`${fieldId}-capability`}
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
            required
            className="h-10 w-full rounded-md border border-border bg-card px-3 text-sm"
          >
            <option value="">{t("federation.permissions.chooseCapability")}</option>
            {FederationCapabilitySchema.options.map((value) => (
              <option key={value} value={value}>
                {t(`federation.permissions.capabilities.${value}`)}
              </option>
            ))}
          </select>
        </div>
        {capability ? (
          <p className="text-sm text-muted-foreground">
            {t(`federation.permissions.effects.${capability}`)}
          </p>
        ) : null}
      </fieldset>
      {error}
      <div className="flex gap-2">
        <Button type="submit" disabled={blocked || !member || !capability}>
          {t(busy ? "federation.saving" : "federation.permissions.grant")}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t("federation.cancel")}
        </Button>
      </div>
    </form>
  );
}
