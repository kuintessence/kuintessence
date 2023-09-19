use proc_macro2::TokenStream;
use quote::quote;
use syn::DeriveInput;

pub fn impl_arrgegate_root(ast: DeriveInput) -> TokenStream {
    let name = ast.ident;

    quote! {
        impl alice_architecture::IAggregateRoot for #name { }
    }
}
