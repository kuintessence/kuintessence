import { parser } from "@lezer/python";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input, Textarea } from "../ui/input";
import { loadSandboxCodeEditor } from "./loadSandboxCodeEditor";

const directives = new Set([
  "version",
  "variant",
  "depends_on",
  "provides",
  "conflicts",
  "license",
  "maintainers",
]);

function editableFields(source: string) {
  const fields: { label: string; value: string; from: number; to: number }[] = [];
  const tree = parser.parse(source);
  for (const cls of tree.topNode.getChildren("ClassDefinition")) {
    const body = cls.getChild("Body");
    for (let stmt = body?.firstChild; stmt; stmt = stmt.nextSibling) {
      const call = stmt.getChild("CallExpression");
      if (
        stmt.name !== "ExpressionStatement" ||
        !call ||
        call.from !== stmt.from ||
        call.to !== stmt.to
      )
        continue;
      const name = call.firstChild;
      const args = call.getChild("ArgList");
      if (name?.name !== "VariableName" || !args) continue;
      const directive = source.slice(name.from, name.to);
      if (!directives.has(directive)) continue;
      for (const arg of args.getChildren("String")) {
        const literal = source.slice(arg.from, arg.to);
        // Structured controls handle plain string literals. All Python expressions remain editable in source.
        let value: string;
        if (/^'[^'\\\r\n]*'$/.test(literal)) value = literal.slice(1, -1);
        else if (literal.startsWith('"')) {
          try {
            value = JSON.parse(literal);
          } catch {
            continue;
          }
        } else continue;
        if (typeof value !== "string" || /[\r\n]/.test(value)) continue;
        const key = arg.prevSibling?.name === "AssignOp" ? arg.prevSibling.prevSibling : null;
        fields.push({
          label: key ? `${directive} · ${source.slice(key.from, key.to)}` : directive,
          value,
          from: arg.from,
          to: arg.to,
        });
      }
    }
  }
  return fields;
}

export function SpackSourceEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState(false);
  const [structured, setStructured] = useState(false);
  const fields = useMemo(() => (structured ? editableFields(value) : []), [value, structured]);
  const module = useQuery({
    queryKey: ["web-module", "sandbox-code-editor"],
    queryFn: loadSandboxCodeEditor,
    staleTime: Infinity,
    enabled: code,
    retry: false,
    networkMode: "always",
  });
  const Editor = code && module.data;
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2 text-sm">
        <span>package.py</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={code}
          onClick={() => setCode(!code)}
        >
          Monaco
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={structured}
          onClick={() => setStructured(!structured)}
        >
          {t("software.manage.recipeFields")}
        </Button>
      </div>
      {Editor ? (
        <Editor language="python" value={value} onChange={onChange} ariaLabel="package.py" />
      ) : (
        <Textarea
          aria-label="package.py"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          placeholder={t("software.manage.packageFilePlaceholder")}
          className="min-h-32 font-mono text-xs"
          data-testid="software-spack-package-file"
        />
      )}
      {code && module.isError && (
        <Button type="button" variant="outline" onClick={() => void module.refetch()}>
          {t("common.retry")}
        </Button>
      )}
      {structured &&
        (fields.length ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {fields.map((field) => (
              <label key={field.from} className="grid gap-1 text-xs">
                {field.label}
                <Input
                  value={field.value}
                  onChange={(e) =>
                    onChange(
                      value.slice(0, field.from) +
                        JSON.stringify(e.target.value) +
                        value.slice(field.to),
                    )
                  }
                />
              </label>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("software.manage.noRecipeFields")}
          </span>
        ))}
    </div>
  );
}
