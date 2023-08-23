#[cfg(feature = "actix")]
use actix::internal_actix_auto_inject;
use auto_inject::internal_auto_inject;
use build_container::internal_build_container;
use proc_macro::TokenStream;
#[cfg(feature = "actix")]
mod actix;
mod auto_inject;
mod build_container;
mod builder;

#[proc_macro]
pub fn build_container(body: TokenStream) -> TokenStream {
    internal_build_container(proc_macro2::TokenStream::from(body)).into()
}

#[proc_macro_attribute]
pub fn auto_inject(attr: TokenStream, body: TokenStream) -> TokenStream {
    internal_auto_inject(
        proc_macro2::TokenStream::from(attr),
        proc_macro2::TokenStream::from(body),
    )
    .into()
}

#[cfg(feature = "actix")]
#[proc_macro_attribute]
pub fn actix_auto_inject(attr: TokenStream, body: TokenStream) -> TokenStream {
    internal_actix_auto_inject(
        proc_macro2::TokenStream::from(attr),
        proc_macro2::TokenStream::from(body),
    )
    .into()
}
