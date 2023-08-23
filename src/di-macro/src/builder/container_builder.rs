use super::{DependencyBuilder, DependencyType};
use proc_macro2::TokenStream;
use quote::format_ident;
use syn::{
    ext::IdentExt, parenthesized, parse::Parse, Attribute, ExprBlock, Field, Ident, Token,
    Visibility,
};

mod kw {
    syn::custom_keyword!(build_container);
    syn::custom_keyword!(params);
    syn::custom_keyword!(scoped_params);
    syn::custom_keyword!(after_build);
}

#[derive(Clone, Debug)]
pub(crate) struct ContainerBuilder {
    pub name: Ident,
    pub metas: Vec<Attribute>,
    pub visibility: Option<Visibility>,
    pub dependencies: Vec<DependencyBuilder>,
    pub struct_params: Vec<Field>,
    pub scoped_struct_params: Vec<Field>,
    pub after_build: Option<ExprBlock>,
}

impl ContainerBuilder {
    fn get_container(&self) -> TokenStream {
        let metas = &self.metas;
        let visibility = &self.visibility;
        let name = &self.name;
        let dependencies: Vec<TokenStream> = self
            .dependencies
            .iter()
            .filter_map(|x| {
                let metas = &x.metas;
                let field = &x.field;
                let dependency_type = &x.dependency_type;
                match dependency_type {
                    DependencyType::Outter | DependencyType::Singleton => Some(quote::quote! {
                        #(#metas)*
                        #field
                    }),
                    _ => None,
                }
            })
            .collect();
        quote::quote! {
            #(#metas)*
            #visibility struct #name {
                #(#dependencies),*
            }
        }
    }

    fn get_need_scoped(&self) -> bool {
        self.dependencies.iter().any(|x| {
            x.dependency_type == DependencyType::Scoped
                || x.dependency_type == DependencyType::Transient
        })
    }

    fn get_scoped_container(&self) -> TokenStream {
        let metas = &self.metas;
        let visibility = &self.visibility;
        let name = format_ident!("{}{}", &self.name, "Scoped");
        let parent_name = &self.name;
        let dependencies: Vec<TokenStream> = self
            .dependencies
            .iter()
            .filter_map(|x| {
                let metas = &x.metas;
                let field = &x.field;
                let dependency_type = &x.dependency_type;
                match dependency_type {
                    DependencyType::Scoped => Some(quote::quote! {
                        #(#metas)*
                        #field
                    }),
                    _ => None,
                }
            })
            .collect();
        let sp = quote::quote! {
            sp: #parent_name,
        };
        quote::quote! {
            #(#metas)*
            #visibility struct #name {
                #sp
                #(#dependencies),*
            }
        }
    }

    fn get_build_fn(&self) -> TokenStream {
        let builder = {
            let struct_params = &self.struct_params;
            let visibility = &self.visibility;
            if struct_params.len() > 5 {
                let name = format_ident!("{}{}", &self.name, "Params");
                Some(quote::quote! {
                    #[derive(::derive_builder::Builder)]
                    #visibility struct #name {
                        #(pub #struct_params,)*
                    }
                })
            } else {
                None
            }
        };
        let is_async = self
            .dependencies
            .iter()
            .any(|x| x.build_async.is_some() && x.dependency_type == DependencyType::Singleton);
        let (init_param, init_vars) = if builder.is_some() {
            let builder_type = format_ident!("{}{}", &self.name, "Params");
            (quote::quote! {params: #builder_type}, {
                let init_vars: Vec<TokenStream> = self
                    .struct_params
                    .iter()
                    .map(|x| {
                        let name = &x.ident;
                        quote::quote! {
                            let #name = params.#name;
                        }
                    })
                    .collect();
                quote::quote! {
                    #(#init_vars)*
                }
            })
        } else {
            let struct_params = &self.struct_params;
            (quote::quote! {#(#struct_params,)*}, quote::quote! {})
        };
        let builds = {
            let dependencies: Vec<TokenStream> = self
                .dependencies
                .iter()
                .filter_map(|x| {
                    let dependency_type = &x.dependency_type;
                    match dependency_type {
                        DependencyType::Outter | DependencyType::Singleton => Some(x.get_build()),
                        _ => None,
                    }
                })
                .collect();
            quote::quote! {
                #(#dependencies)*
            }
        };
        let names: Vec<&proc_macro2::Ident> = self
            .dependencies
            .iter()
            .filter_map(|x| {
                let dependency_type = &x.dependency_type;
                match dependency_type {
                    DependencyType::Outter | DependencyType::Singleton => Some(x.get_name()),
                    _ => None,
                }
            })
            .collect();
        let after_build = if self.after_build.is_some() {
            let after_build = &self.after_build;
            quote::quote! {
                let mut sp = Self {
                    #(#names),*
                };
                #after_build
                Ok(sp)
            }
        } else {
            quote::quote! {
                Ok(Self {
                    #(#names),*
                })
            }
        };
        let name = &self.name;
        if is_async {
            quote::quote! {
                #builder
                impl #name {
                    pub async fn build(#init_param) -> anyhow::Result<Self> {
                        #init_vars
                        #builds
                        #after_build
                    }
                }
            }
        } else {
            quote::quote! {
                #builder
                impl #name {
                    pub fn build(#init_param) -> anyhow::Result<Self> {
                        #init_vars
                        #builds
                        #after_build
                    }
                }
            }
        }
    }

    fn get_scoped_build_fn(&self) -> TokenStream {
        let name = format_ident!("{}{}", &self.name, "Scoped");
        let builder = {
            let struct_params = &self.scoped_struct_params;
            let visibility = &self.visibility;
            if struct_params.len() > 5 {
                let name = format_ident!("{}{}", &self.name, "ScopedParams");
                Some(quote::quote! {
                    #[derive(::derive_builder::Builder)]
                    #visibility struct #name {
                        #(pub #struct_params,)*
                    }
                })
            } else {
                None
            }
        };
        let is_async = self
            .dependencies
            .iter()
            .any(|x| x.build_async.is_some() && x.dependency_type == DependencyType::Scoped);
        let (init_param, init_vars) = if builder.is_some() {
            let builder_type = format_ident!("{}{}", name, "Params");
            (quote::quote! {params: #builder_type}, {
                let init_vars: Vec<TokenStream> = self
                    .struct_params
                    .iter()
                    .map(|x| {
                        let name = &x.ident;
                        quote::quote! {
                            let #name = params.#name;
                        }
                    })
                    .collect();
                quote::quote! {
                    #(#init_vars)*
                }
            })
        } else {
            let struct_params = &self.scoped_struct_params;
            (quote::quote! {#(#struct_params,)*}, quote::quote! {})
        };
        let builds = {
            let dependencies: Vec<TokenStream> = self
                .dependencies
                .iter()
                .filter_map(|x| {
                    let dependency_type = &x.dependency_type;
                    match dependency_type {
                        DependencyType::Scoped => Some(x.get_build()),
                        _ => None,
                    }
                })
                .collect();
            quote::quote! {
                #(#dependencies)*
            }
        };
        let names: Vec<&proc_macro2::Ident> = self
            .dependencies
            .iter()
            .filter_map(|x| {
                let dependency_type = &x.dependency_type;
                match dependency_type {
                    DependencyType::Scoped => Some(x.get_name()),
                    _ => None,
                }
            })
            .collect();
        let after_build = quote::quote! {
            Ok(#name {
                sp,
                #(#names),*
            })
        };
        let parent_name = &self.name;
        if is_async {
            quote::quote! {
                #builder
                impl #parent_name {
                    pub async fn create_scoped(&self, #init_param) -> anyhow::Result<#name> {
                        let sp = self.clone();
                        #init_vars
                        #builds
                        #after_build
                    }
                }
            }
        } else {
            quote::quote! {
                #builder
                impl #parent_name {
                    pub fn create_scoped(&self, #init_param) -> anyhow::Result<#name> {
                        let sp = self.clone();
                        #init_vars
                        #builds
                        #after_build
                    }
                }
            }
        }
    }

    fn build_container(&self) -> TokenStream {
        let container = self.get_container();
        let impl_container_trait: Vec<TokenStream> = self
            .dependencies
            .iter()
            .filter_map(|x| match &x.dependency_type {
                DependencyType::Outter | DependencyType::Singleton => {
                    Some(x.get_provides(&self.name))
                }
                _ => None,
            })
            .collect();
        let build_fn = self.get_build_fn();
        quote::quote! {
            #container
            #build_fn
            #(#impl_container_trait)*
        }
    }

    fn build_scoped_container(&self) -> TokenStream {
        if self.get_need_scoped() {
            let name = format_ident!("{}{}", &self.name, "Scoped");
            let container = self.get_scoped_container();
            let build_fn = self.get_scoped_build_fn();
            let impl_container_trait: Vec<TokenStream> = self
                .dependencies
                .iter()
                .map(|x| match &x.dependency_type {
                    DependencyType::Scoped | DependencyType::Transient => x.get_provides(&name),
                    DependencyType::Outter | DependencyType::Singleton => {
                        x.get_scoped_singleton_provides(&name)
                    }
                })
                .collect();
            quote::quote! {
                #container
                #build_fn
                #(#impl_container_trait)*
            }
        } else {
            quote::quote! {}
        }
    }

    pub fn build(&self) -> TokenStream {
        let container = self.build_container();
        let scoped_container = self.build_scoped_container();
        quote::quote! {
            #container
            #scoped_container
        }
    }
}

impl Parse for ContainerBuilder {
    fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
        let metas = input.call(Attribute::parse_outer)?;
        let visibility = input.call(Visibility::parse).ok();
        let _ = input.parse::<Token![struct]>()?;
        let name = input.parse::<Ident>()?;
        let _ = input.parse::<Token![;]>()?;
        let mut struct_params = vec![];
        if input.peek(kw::params) {
            let _ = input.parse::<kw::params>()?;
            let params;
            parenthesized!(params in input);
            while params.peek(Ident::peek_any) {
                struct_params.push(params.call(Field::parse_named)?);
                let _ = params.parse::<Token![,]>().ok();
            }
        }
        let mut scoped_struct_params = vec![];
        if input.peek(kw::scoped_params) {
            let _ = input.parse::<kw::scoped_params>()?;
            let params;
            parenthesized!(params in input);
            while params.peek(Ident::peek_any) {
                scoped_struct_params.push(params.call(Field::parse_named)?);
                let _ = params.parse::<Token![,]>().ok();
            }
        }
        let mut dependencies = vec![];
        while input.peek(Ident::peek_any) && !input.peek(kw::after_build) {
            dependencies.push(input.call(DependencyBuilder::parse)?);
        }
        let after_build = if input.peek(kw::after_build) {
            let _ = input.parse::<kw::after_build>()?;
            Some(input.call(ExprBlock::parse)?)
        } else {
            None
        };
        Ok(Self {
            name,
            metas,
            visibility,
            dependencies,
            struct_params,
            after_build,
            scoped_struct_params,
        })
    }
}
