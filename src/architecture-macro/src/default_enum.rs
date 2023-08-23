use proc_macro2::TokenStream;
use quote::format_ident;
use std::str::FromStr;
use syn::{parse2, Error, ItemEnum};

fn pasecal_to_snake(s: &str) -> String {
    let mut result = String::new();
    if s.is_empty() {
        return result;
    }
    let mut chars = s.chars();
    result.push(chars.next().unwrap().to_ascii_lowercase());
    for n in chars {
        if n.is_uppercase() {
            result.push('_');
            result.push(n.to_ascii_lowercase());
        } else {
            result.push(n);
        }
    }
    result
}

pub(crate) fn enum_default(input: TokenStream) -> TokenStream {
    let body: ItemEnum = match parse2(input) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };
    let (ident, variants) = (&body.ident, &body.variants);
    let fns: Vec<TokenStream> = variants
        .iter()
        .filter_map(|v| {
            let item_ident = &v.ident;
            let attr = &v
                .attrs
                .iter()
                .find(|attr| attr.path.get_ident().unwrap().to_string().eq("enum_default"));
            let meta = match attr {
                Some(x) => x.parse_meta().ok(),
                None => return None,
            };
            let fn_name = format_ident!("{}_default", pasecal_to_snake(&item_ident.to_string()));
            match meta {
                Some(x) => match x {
                    syn::Meta::Path(_) => {
                        let fields = &v.fields;
                        if fields.is_empty() {
                            return None;
                        }
                        let is_named = fields.iter().next().unwrap().ident.is_some();
                        let items = fields.iter().map(|f| {
                            let ident = &f.ident;
                            let attr = &f.attrs.iter().find(|attr| {
                                attr.path.get_ident().unwrap().to_string().eq("enum_default")
                            });
                            let meta = match attr {
                                Some(x) => match x.parse_meta() {
                                    Ok(x) => match x {
                                        syn::Meta::NameValue(meta) => {
                                            let lit = match &meta.lit {
                                                syn::Lit::Str(x) => {
                                                    match TokenStream::from_str(x.value().as_str())
                                                    {
                                                        Ok(x) => x,
                                                        Err(e) => Error::new(
                                                            meta.lit.span(),
                                                            format!("enum_default: {}", e),
                                                        )
                                                        .into_compile_error(),
                                                    }
                                                }
                                                _ => {
                                                    return Error::new(
                                                        meta.lit.span(),
                                                        "enum_default must be string",
                                                    )
                                                    .into_compile_error()
                                                }
                                            };
                                            quote::quote! {
                                                #lit
                                            }
                                        }
                                        _ => quote::quote! {
                                            Default::default()
                                        },
                                    },
                                    Err(_) => quote::quote! {
                                        Default::default()
                                    },
                                },
                                None => quote::quote! {
                                    Default::default()
                                },
                            };
                            if is_named {
                                quote::quote! {
                                    #ident: #meta
                                }
                            } else {
                                quote::quote! {
                                    #meta
                                }
                            }
                        });
                        if is_named {
                            Some(quote::quote! {
                                pub fn #fn_name() -> Self {
                                    #ident::#item_ident {
                                        #(#items),*
                                    }
                                }
                            })
                        } else {
                            Some(quote::quote! {
                                pub fn #fn_name() -> Self {
                                    #ident::#item_ident(#(#items),*)
                                }
                            })
                        }
                    }
                    syn::Meta::NameValue(meta) => {
                        let fields = &v.fields;
                        let lit = match &meta.lit {
                            syn::Lit::Str(x) => match TokenStream::from_str(x.value().as_str()) {
                                Ok(x) => x,
                                Err(e) => {
                                    return Some(
                                        Error::new(meta.lit.span(), format!("enum_default: {}", e))
                                            .into_compile_error(),
                                    );
                                }
                            },
                            _ => {
                                return Some(
                                    Error::new(meta.lit.span(), "enum_default must be string")
                                        .into_compile_error(),
                                )
                            }
                        };
                        match fields.iter().next() {
                            Some(f) => match f.ident {
                                Some(_) => Some(quote::quote! {
                                    pub fn #fn_name() -> Self {
                                        #ident::#item_ident {
                                            #lit
                                        }
                                    }
                                }),
                                None => Some(quote::quote! {
                                    pub fn #fn_name() -> Self {
                                        #ident::#item_ident(#meta)
                                    }
                                }),
                            },
                            None => None,
                        }
                    }
                    _ => None,
                },
                None => None,
            }
        })
        .collect();
    quote::quote! {
        impl #ident {
            #(#fns)*
        }
    }
}
