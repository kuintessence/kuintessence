use bytesize::ByteSize;
use rustix::fs::statvfs;
use rustix::io;

#[inline]
pub fn total() -> io::Result<ByteSize> {
    statvfs(".").map(|stat| ByteSize::b(stat.f_frsize * stat.f_blocks))
}

#[inline]
pub fn used() -> io::Result<ByteSize> {
    statvfs(".").map(|stat| ByteSize::b(stat.f_frsize * (stat.f_blocks - stat.f_bfree)))
}
