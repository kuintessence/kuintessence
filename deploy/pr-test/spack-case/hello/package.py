from spack.package import Executable, Package, depends_on, license, version


class Hello(Package):
    """GNU Hello release tarball, built without regenerating Autotools files."""

    homepage = "https://www.gnu.org/software/hello/"
    # Listed at www.gnu.org/prep/ftp.html; keep the upstream release checksum.
    url = "https://mirrors.ocf.berkeley.edu/gnu/hello/hello-2.12.1.tar.gz"

    # Official NixOS metadata, not a digest learned from our own download:
    # github.com/NixOS/nixpkgs/blob/34b62f7c47d9e11cf95b01473e9a380e9d331a6d/
    # pkgs/by-name/he/hello/package.nix
    # SRI: sha256-jZkUKv2SV28wsM18tCqNxoCZmLxdYH2Idh9RLibH2yA=
    version(
        "2.12.1",
        sha256="8d99142afd92576f30b0cd7cb42a8dc6809998bc5d607d88761f512e26c7db20",
    )
    license("GPL-3.0-or-later")
    depends_on("c", type="build")
    depends_on("gmake", type="build")

    def install(self, spec, prefix):
        Executable("./configure")("--prefix=" + str(prefix), "--disable-nls")
        make = Executable(str(spec["gmake"].prefix.bin.make))
        make("-j2")
        make("install")
