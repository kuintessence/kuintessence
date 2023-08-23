use proc_macro::TokenStream;
mod default_enum;

#[proc_macro_derive(EnumDefault, attributes(enum_default))]
pub fn enum_default(input: TokenStream) -> TokenStream {
    default_enum::enum_default(proc_macro2::TokenStream::from(input)).into()
}
