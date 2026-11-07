import {
  FederationCertificateInput,
  FederationKeyInput,
  FederationSiteInput,
  type FederationSiteView,
} from "@kuintessence/shared/federation";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { z } from "zod";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";

interface FormProps<T> {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: T) => void;
}
export function FederationSiteForm({
  site,
  busy,
  onCancel,
  onSubmit,
}: FormProps<z.infer<typeof FederationSiteInput>> & { site?: FederationSiteView }) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [id, setId] = useState(site?.id ?? "");
  const [name, setName] = useState(site?.name ?? "");
  const [endpoint, setEndpoint] = useState(site?.endpoint ?? "");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = FederationSiteInput.safeParse({
          id: id.trim(),
          name,
          endpoint: endpoint.trim(),
        });
        if (!parsed.success) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        onSubmit(parsed.data);
      }}
    >
      <h3 className="text-base font-semibold">
        {t(site ? "federation.editSite" : "federation.addSite")}
      </h3>
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm" htmlFor={`${fieldId}-siteName`}>
          {t("federation.siteName")}
          <Input
            id={`${fieldId}-siteName`}
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm" htmlFor={`${fieldId}-siteId`}>
          {t("federation.siteId")}
          <Input
            id={`${fieldId}-siteId`}
            required
            readOnly={!!site}
            value={id}
            onChange={(e) => setId(e.target.value)}
            className="font-mono"
          />
        </label>
        <label className="space-y-1 text-sm sm:col-span-2" htmlFor={`${fieldId}-endpoint`}>
          {t("federation.endpoint")}
          <Input
            id={`${fieldId}-endpoint`}
            required
            type="url"
            maxLength={2048}
            value={endpoint}
            placeholder="https://federation.example.org"
            onChange={(e) => setEndpoint(e.target.value)}
          />
        </label>
      </fieldset>
      {invalid && (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.invalidSite")}
        </p>
      )}
      <FormActions busy={busy} onCancel={onCancel} />
    </form>
  );
}

function FormActions({ busy, onCancel }: Pick<FormProps<unknown>, "busy" | "onCancel">) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={busy}>
        {t(busy ? "federation.saving" : "federation.save")}
      </Button>
      <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
        {t("federation.cancel")}
      </Button>
    </div>
  );
}

export function FederationKeyForm({
  busy,
  onCancel,
  onSubmit,
}: FormProps<z.infer<typeof FederationKeyInput>>) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [keyId, setKeyId] = useState("");
  const [pem, setPem] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const [kinds, setKinds] = useState<
    Array<z.infer<typeof FederationKeyInput>["allowedKinds"][number]>
  >([]);
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const start = Date.parse(from),
          end = Date.parse(until);
        const parsed = FederationKeyInput.safeParse({
          keyId: keyId.trim(),
          publicKeyPem: pem.trim(),
          allowedKinds: kinds,
          validFrom: Number.isFinite(start) ? new Date(start).toISOString() : "",
          validUntil: Number.isFinite(end) ? new Date(end).toISOString() : "",
        });
        if (!parsed.success || !pem.trim().startsWith("-----BEGIN PUBLIC KEY-----")) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        onSubmit(parsed.data);
      }}
    >
      <h3 className="text-base font-semibold">{t("federation.addKey")}</h3>
      <fieldset disabled={busy} className="space-y-4">
        <label className="block space-y-1 text-sm" htmlFor={`${fieldId}-keyId`}>
          {t("federation.keyId")}
          <Input
            id={`${fieldId}-keyId`}
            required
            maxLength={128}
            value={keyId}
            onChange={(e) => setKeyId(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-sm" htmlFor={`${fieldId}-publicKey`}>
          {t("federation.publicKey")}
          <Textarea
            id={`${fieldId}-publicKey`}
            required
            rows={5}
            maxLength={16384}
            value={pem}
            onChange={(e) => setPem(e.target.value)}
            className="font-mono"
            spellCheck={false}
          />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-sm" htmlFor={`${fieldId}-validFrom`}>
            {t("federation.validFrom")}
            <Input
              id={`${fieldId}-validFrom`}
              type="datetime-local"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="block space-y-1 text-sm" htmlFor={`${fieldId}-validUntil`}>
            {t("federation.validUntil")}
            <Input
              id={`${fieldId}-validUntil`}
              type="datetime-local"
              required
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium">{t("federation.purposes")}</legend>
          <div className="grid gap-x-6 sm:grid-cols-2">
            {FederationKeyInput.shape.allowedKinds.element.options.map((kind) => (
              <label key={kind} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={kinds.includes(kind)}
                  onChange={(e) =>
                    setKinds(e.target.checked ? [...kinds, kind] : kinds.filter((x) => x !== kind))
                  }
                />
                {t(`federation.kinds.${kind}`)}
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
      {invalid && (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.invalidKey")}
        </p>
      )}
      <FormActions busy={busy} onCancel={onCancel} />
    </form>
  );
}

export function FederationCertificateForm({
  busy,
  onCancel,
  onSubmit,
}: FormProps<z.infer<typeof FederationCertificateInput>>) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [pem, setPem] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = FederationCertificateInput.safeParse({ certificatePem: pem.trim() });
        if (!parsed.success || !pem.trim().startsWith("-----BEGIN CERTIFICATE-----")) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        onSubmit(parsed.data);
      }}
    >
      <h3 className="text-base font-semibold">{t("federation.addCertificate")}</h3>
      <label className="block space-y-1 text-sm" htmlFor={`${fieldId}-certificatePem`}>
        {t("federation.certificatePem")}
        <Textarea
          id={`${fieldId}-certificatePem`}
          required
          rows={8}
          maxLength={16384}
          disabled={busy}
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          className="font-mono"
          spellCheck={false}
        />
      </label>
      {invalid && (
        <p role="alert" className="text-sm text-status-failed">
          {t("federation.invalidCertificate")}
        </p>
      )}
      <FormActions busy={busy} onCancel={onCancel} />
    </form>
  );
}
