/// 在 mod 中帮助全局 pub
/// ```no_run
/// // code
/// make_pub_mod!(xxxx);
/// // gen
/// pub mod xxx;
/// ```
#[macro_export]
macro_rules! make_pub_mod {
    ($( $(#[$meta:meta])* $mod_name:ident ),*) => {
        $($(#[$meta])* pub mod $mod_name;)*
    };
}

/// 在 mod 中帮助 re-export
/// ```no_run
/// // code
/// make_re_export!(xxxx);
/// // gen
/// mod xxx;
/// pub use xxx::*;
/// ```
#[macro_export]
macro_rules! make_re_export {
    ($($(#[$meta:meta])*  $mod_name:ident ),*) => {
        $($(#[$meta])* pub mod $mod_name;)*
        $($(#[$meta])* pub use self::$mod_name::*;)*
    };
}

/// 帮助闭包时将可进行 clone 的变量进行 clone
/// ```no_run
/// // code
/// enclose!(xxxx, async move {});
/// // gen
/// let xxx = xxx.clone();
/// async move {}
/// ```
#[macro_export]
macro_rules! enclose {
    ( ($( $x:ident ),*) $y:expr ) => {
        {
            $(let $x = $x.clone();)*
            $y
        }
    };
}

make_re_export!(
    authorization,
    exceptions,
    hosting,
    repository,
    base_dto,
    message_queue,
    model
);
