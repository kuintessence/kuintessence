use rustix::fs::statvfs;

#[inline]
pub fn total() -> rustix::io::Result<u64> {
    statvfs(".").map(|stat| stat.f_frsize * stat.f_blocks)
}

#[inline]
pub fn used() -> rustix::io::Result<u64> {
    statvfs(".").map(|stat| stat.f_frsize * (stat.f_blocks - stat.f_bfree))
}
