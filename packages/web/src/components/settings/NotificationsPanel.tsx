import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface Preferences {
  emailAvailable: boolean;
  emailEnabled: boolean;
  webhookUrl: string | null;
}
interface Item {
  id: string;
  kind: string;
  message: string;
  readAt: string | null;
  createdAt: string;
}

function DeliverySettings({
  preferences,
  saved,
}: {
  preferences: Preferences;
  saved: (value: Preferences) => void;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(preferences.emailEnabled);
  const [url, setUrl] = useState(preferences.webhookUrl ?? "");
  const [secret, setSecret] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.put<Preferences>("/notifications/preferences", {
        emailEnabled: email,
        webhookUrl: url.trim() || null,
        ...(secret ? { webhookSecret: secret } : {}),
      }),
    onSuccess: (value) => {
      setSecret("");
      saved(value);
    },
  });
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={email}
          disabled={!preferences.emailAvailable}
          onChange={(e) => setEmail(e.target.checked)}
        />
        {t("notifications.email")}
      </label>
      <label className="block">
        {t("notifications.webhook")}
        <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      {url && (
        <label className="block">
          {t("notifications.secret")}
          <Input
            type="password"
            autoComplete="new-password"
            minLength={16}
            required={url.trim() !== preferences.webhookUrl}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      )}
      <Button disabled={save.isPending} type="submit">
        {t("common.save")}
      </Button>
      {save.isError && <p role="alert">{t("notifications.failed")}</p>}
      {save.isSuccess && <p role="status">{t("notifications.saved")}</p>}
    </form>
  );
}

function Inbox({ account }: { account: string }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [offset, setOffset] = useState(0);
  const listKey = ["notifications", account, "items", offset];
  const prefKey = ["notifications", account, "preferences"];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => api.get<{ items: Item[] }>(`/notifications?offset=${offset}`),
    refetchInterval: 30_000,
  });
  const prefs = useQuery({
    queryKey: prefKey,
    queryFn: () => api.get<Preferences>("/notifications/preferences"),
  });
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`, {}),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["notifications", account, "items"] }),
  });
  return (
    <div className="space-y-4 pt-3">
      {list.isError || prefs.isError || read.isError ? (
        <p role="alert">
          {t("notifications.failed")}{" "}
          <Button
            variant="outline"
            onClick={() => {
              void list.refetch();
              void prefs.refetch();
            }}
          >
            {t("common.retry")}
          </Button>
        </p>
      ) : null}
      {list.isLoading && <p>{t("common.loading")}</p>}
      {list.data && !list.isError && (
        <>
          {list.data.items.length === 0 && <p>{t("notifications.empty")}</p>}
          <ul>
            {list.data.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b py-2"
              >
                <div>
                  <div className="break-words">{item.message}</div>
                  <time className="text-sm text-muted-foreground" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString()}
                  </time>
                </div>
                {!item.readAt && (
                  <Button
                    variant="outline"
                    disabled={read.isPending}
                    onClick={() => read.mutate(item.id)}
                  >
                    {t("notifications.read")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {(offset > 0 || list.data.items.length === 25) && (
            <div className="flex gap-2">
              <Button disabled={offset === 0} onClick={() => setOffset(offset - 25)}>
                {t("common.previous")}
              </Button>
              <Button disabled={list.data.items.length < 25} onClick={() => setOffset(offset + 25)}>
                {t("common.next")}
              </Button>
            </div>
          )}
        </>
      )}
      {prefs.data && !prefs.isError && (
        <DeliverySettings
          preferences={prefs.data}
          saved={(value) => cache.setQueryData(prefKey, value)}
        />
      )}
    </div>
  );
}

export function NotificationsPanel({ account }: { account: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">{t("notifications.title")}</summary>
      {open && <Inbox key={account} account={account} />}
    </details>
  );
}
