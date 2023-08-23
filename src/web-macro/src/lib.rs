use authorize::internal_authorize;
use http_request::internal_http_request;
use message_consumer::internal_message_consumer;
use proc_macro::TokenStream;
mod authorize;
mod http_request;
mod message_consumer;
#[proc_macro_attribute]
pub fn authorize(attr: TokenStream, body: TokenStream) -> TokenStream {
    internal_authorize(
        proc_macro2::TokenStream::from(attr),
        proc_macro2::TokenStream::from(body),
    )
    .into()
}

#[proc_macro_attribute]
pub fn http_request(attr: TokenStream, body: TokenStream) -> TokenStream {
    internal_http_request(
        proc_macro2::TokenStream::from(attr),
        proc_macro2::TokenStream::from(body),
    )
    .into()
}

#[proc_macro_attribute]
pub fn message_consumer(attr: TokenStream, body: TokenStream) -> TokenStream {
    internal_message_consumer(
        proc_macro2::TokenStream::from(attr),
        proc_macro2::TokenStream::from(body),
    )
    .into()
}
