/**
 * Turns a SoftwareUsecaseComputing node's bound slot values into an executable task.
 * See
 * docs/workflow-schema/README.md#materialization.
 */
export { batchOutputPathsDescriptor } from "./batch-output";
export {
  type ArgumentMaterial,
  type EnvironmentMaterial,
  type FileInputValue,
  type FileKind,
  type FilesomeInputMaterial,
  type FilesomeOutputMaterial,
  type FileValue,
  type MaterializedTask,
  type MaterializeInput,
  type MaterialRef,
  materialize,
  type SoftwareSpec,
  type UsecaseInputSlot,
} from "./materialize";
export {
  type DataAssetRequirement,
  type DataAssetSelector,
  type DatasetDataRequirements,
  type GovernedUsecasePackage,
  GovernedUsecasePackageSchema,
  type MaterializationPackage,
  MaterializationPackageSchema,
  type UsecasePackage,
  type UsecasePackageCreate,
  UsecasePackageCreateSchema,
  UsecasePackageSchema,
  type UsecasePackageUpdate,
  UsecasePackageUpdateSchema,
} from "./package";
export { renderTemplate } from "./template";
export { coerceTyped, extractTyped, extractValue, extractValues } from "./value-extract";
export { wrapCommand } from "./wrap-command";
