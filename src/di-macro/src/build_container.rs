use crate::builder::ContainerBuilder;
use proc_macro2::TokenStream;
use syn::parse2;

pub fn internal_build_container(body: TokenStream) -> TokenStream {
    let input = match parse2::<ContainerBuilder>(body) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };

    input.build()
}
