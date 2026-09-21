import { fileURLToPath } from "node:url";
import { GenericContainer, Wait } from "testcontainers";

export const RUSTFS_IMAGE = "rustfs/rustfs:1.0.0";
export const RUSTFS_RC_IMAGE = "rustfs/rc:v0.1.36";
export const NETDRIVE_BUCKET = "kq-netdrive";
export const DATA_MARKET_STAGING_BUCKET = "kq-data-market-staging";
export const DATA_MARKET_IMMUTABLE_BUCKET = "kq-data-market-immutable";
export const COMMITTER_ACCESS_KEY = "kq-e2e-committer";
export const COMMITTER_SECRET_KEY = "kq-e2e-committer-secret";

export async function startObjectStorage() {
  const rustfs = await new GenericContainer(RUSTFS_IMAGE)
    .withCommand(["rustfs", "/data"])
    .withEnvironment({
      RUSTFS_ACCESS_KEY: "rustfsadmin",
      RUSTFS_SECRET_KEY: "rustfsadmin",
      RUSTFS_CONSOLE_ENABLE: "false",
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/health", 9000).forStatusCode(200))
    .withStartupTimeout(90_000)
    .start();

  const bootstrap = async (secretKey = COMMITTER_SECRET_KEY) => {
    const initializer = await new GenericContainer(RUSTFS_RC_IMAGE)
      .withNetworkMode(`container:${rustfs.getId()}`)
      .withEntrypoint(["sh"])
      .withCommand(["/bootstrap-object-lock.sh"])
      .withEnvironment({
        RUSTFS_ENDPOINT: "http://127.0.0.1:9000",
        RUSTFS_ACCESS_KEY: "rustfsadmin",
        RUSTFS_SECRET_KEY: "rustfsadmin",
        RUSTFS_READY_TIMEOUT_SECONDS: "30",
        NETDRIVE_BUCKET,
        DATA_MARKET_STAGING_BUCKET,
        DATA_MARKET_IMMUTABLE_BUCKET,
        DATA_MARKET_COMMITTER_ACCESS_KEY: COMMITTER_ACCESS_KEY,
        DATA_MARKET_COMMITTER_SECRET_KEY: secretKey,
      })
      .withCopyFilesToContainer([
        {
          source: fileURLToPath(
            new URL("../../../deploy/rustfs/bootstrap-object-lock.sh", import.meta.url),
          ),
          target: "/bootstrap-object-lock.sh",
        },
      ])
      .withWaitStrategy(Wait.forOneShotStartup())
      .withStartupTimeout(90_000)
      .start();
    await initializer.stop({ remove: true, removeVolumes: true });
  };

  try {
    await bootstrap();
    return {
      endpoint: rustfs.getHost(),
      port: rustfs.getMappedPort(9000),
      bucket: NETDRIVE_BUCKET,
      bootstrap,
      stop: () => rustfs.stop({ remove: true, removeVolumes: true }),
    };
  } catch (error) {
    await rustfs.stop({ remove: true, removeVolumes: true });
    throw error;
  }
}
