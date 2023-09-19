mod aggregate_root;

use proc_macro::TokenStream;
use syn::parse_macro_input;
use syn::DeriveInput;

#[proc_macro_derive(IAggregateRoot)]
pub fn derive_aggregate_root(input: TokenStream) -> TokenStream {
    let ast = parse_macro_input!(input as DeriveInput);
    aggregate_root::impl_arrgegate_root(ast).into()
}
