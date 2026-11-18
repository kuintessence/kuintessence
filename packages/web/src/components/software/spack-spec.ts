import type { SpackCatalogPackage, UsecasePackageSpec } from "../../lib/software-client";
import { optionalText } from "./software-fields";
import { catalogPackageKey } from "./spack-catalog";

interface SpackSpecConfig {
  compiler: string;
  moduleName: string;
  variants: string;
  version: string;
}

export function makeSpackSpecPreview(
  packageName: string,
  version: string,
  compiler: string,
  variants: string,
  defaultSpec?: string,
): string {
  if (defaultSpec && !version.trim() && !compiler.trim() && !variants.trim()) return defaultSpec;
  const head = `${packageName}${version.trim() ? `@${version.trim()}` : ""}${
    compiler.trim() ? `%${compiler.trim()}` : ""
  }`;
  const tail = variants.trim();
  return tail ? `${head} ${tail}` : head;
}

function makeSpackSoftwareSpec(
  pkg: SpackCatalogPackage,
  config: SpackSpecConfig,
): UsecasePackageSpec["software"] {
  const version = optionalText(config.version);
  const compiler = optionalText(config.compiler);
  const useDefault = !!pkg.defaultSpec && !version && !compiler && !config.variants.trim();
  return {
    kind: "Spack",
    name:
      useDefault && pkg.defaultSpec
        ? pkg.defaultSpec
        : makeSpackSpecPreview(pkg.metadata?.name ?? pkg.name, version ?? "", compiler ?? "", ""),
    ...(version ? { version } : {}),
    ...(compiler ? { compiler } : {}),
    ...(optionalText(config.moduleName) ? { moduleName: optionalText(config.moduleName) } : {}),
    variantRef: catalogPackageKey(pkg),
    argumentList: config.variants.split(/\s+/).filter((token) => token.length > 0),
  };
}

export function makeUsecaseSpec(
  commandFile: string,
  inputDescriptor: string,
  argumentFormat: string,
  software: SpackCatalogPackage,
  specConfig: SpackSpecConfig,
): UsecasePackageSpec {
  const descriptor = inputDescriptor.trim();
  const hasInput = descriptor.length > 0;
  return {
    usecase: {
      commandFile,
      inputSlots: hasInput
        ? [
            {
              kind: "Text",
              descriptor,
              refMaterials: [{ kind: "ArgRef", descriptor, sort: 0 }],
            },
          ]
        : [],
    },
    software: makeSpackSoftwareSpec(software, specConfig),
    arguments: hasInput ? [{ descriptor, valueFormat: argumentFormat.trim() || "{}" }] : [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  };
}
