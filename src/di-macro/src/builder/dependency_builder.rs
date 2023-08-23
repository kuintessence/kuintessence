use proc_macro2::TokenStream;
use syn::{
    braced, bracketed, ext::IdentExt, parse::Parse, Attribute, ExprAsync, ExprBlock, Field, Ident,
    Token, Type,
};

mod kw {
    syn::custom_keyword!(scoped);
    syn::custom_keyword!(build);
    syn::custom_keyword!(provide);
    syn::custom_keyword!(outer);
    syn::custom_keyword!(transient);
}

#[derive(Clone, Debug)]
pub(crate) struct DependencyBuilder {
    pub metas: Vec<Attribute>,
    pub field: Field,
    pub build: Option<ExprBlock>,
    pub build_async: Option<ExprAsync>,
    pub provides: Vec<Type>,
    pub dependency_type: DependencyType,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum DependencyType {
    Outter,
    Singleton,
    Scoped,
    Transient,
}

impl DependencyBuilder {
    pub fn get_build(&self) -> TokenStream {
        let name = self.get_name();
        if self.dependency_type == DependencyType::Outter {
            return quote::quote! {};
        }
        if let Some(b) = self.build.as_ref() {
            return quote::quote! {let #name = #b;};
        }
        if let Some(b) = self.build_async.as_ref() {
            let b = &b.block;
            return quote::quote! {let #name = #b;};
        }
        quote::quote! {}
    }

    pub fn get_name(&self) -> &proc_macro2::Ident {
        self.field.ident.as_ref().unwrap()
    }

    pub fn get_scoped_singleton_provides(
        &self,
        container_name: &proc_macro2::Ident,
    ) -> TokenStream {
        match self.dependency_type {
            DependencyType::Outter | DependencyType::Singleton => {
                let provides = &self.provides;
                let type_name = &self.field.ty;
                let provides = quote::quote! {
                    #(
                        impl IServiceProvider<#provides> for #container_name {
                            fn provide(&self) -> #provides {
                                self.sp.provide()
                            }
                        }
                    )*
                };
                quote::quote! {
                    impl IServiceProvider<#type_name> for #container_name {
                        fn provide(&self) -> #type_name {
                            self.sp.provide()
                        }
                    }
                    #provides
                }
            }
            _ => quote::quote! {},
        }
    }

    pub fn get_provides(&self, container_name: &proc_macro2::Ident) -> TokenStream {
        if self.dependency_type == DependencyType::Transient {
            let provides = &self.provides;
            let is_async = self.build_async.is_some();
            let type_name = &self.field.ty;
            if is_async {
                let build = &self.build_async;
                let provides = quote::quote! {
                    #(
                        #[::async_trait::async_trait]
                        impl IAsyncServiceProvider<#provides> for #container_name {
                            async fn provide_async(&self) -> #provides {
                                let sp = self;
                                #build.await
                            }
                        }
                    )*
                };
                quote::quote! {
                    #[::async_trait::async_trait]
                    impl IAsyncServiceProvider<#type_name> for #container_name {
                        async fn provide_async(&self) -> #type_name {
                            let sp = self;
                            #build.await
                        }
                    }
                    #provides
                }
            } else {
                let build = &self.build;
                let provides = quote::quote! {
                    #(
                        impl IServiceProvider<#provides> for #container_name {
                            fn provide(&self) -> #provides {
                                let sp = self;
                                #build
                            }
                        }
                    )*
                };
                quote::quote! {
                    impl IServiceProvider<#type_name> for #container_name {
                        fn provide(&self) -> #type_name {
                            let sp = self;
                            #build
                        }
                    }
                    #provides
                }
            }
        } else {
            let provides = &self.provides;
            let name = self.get_name();
            let type_name = &self.field.ty;
            let provides = quote::quote! {
                #(
                    impl IServiceProvider<#provides> for #container_name {
                        fn provide(&self) -> #provides {
                            self.#name.clone()
                        }
                    }
                )*
            };
            quote::quote! {
                impl IServiceProvider<#type_name> for #container_name {
                    fn provide(&self) -> #type_name {
                        self.#name.clone()
                    }
                }
                #provides
            }
        }
    }
}

impl Parse for DependencyBuilder {
    fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
        let metas = input.call(Attribute::parse_outer)?;
        let dependency_type = if input.peek(kw::scoped) {
            let _ = input.parse::<kw::scoped>()?;
            DependencyType::Scoped
        } else if input.peek(kw::outer) {
            let _ = input.parse::<kw::outer>()?;
            DependencyType::Outter
        } else if input.peek(kw::transient) {
            let _ = input.parse::<kw::transient>()?;
            DependencyType::Transient
        } else {
            DependencyType::Singleton
        };
        let field = input.call(Field::parse_named)?;
        let body;
        braced!(body in input);
        let mut provides = vec![];
        if body.peek(kw::provide) {
            let _ = body.parse::<kw::provide>()?;
            let provides_body;
            bracketed!(provides_body in body);
            while provides_body.peek(Ident::peek_any) {
                provides.push(provides_body.call(Type::parse)?);
                let _ = provides_body.parse::<Token![,]>().ok();
            }
        }
        let (build, build_async) = if dependency_type == DependencyType::Outter {
            (None, None)
        } else if body.peek(kw::build) && body.peek2(Token![async]) {
            let _ = body.parse::<kw::build>()?;
            let build = body.call(ExprAsync::parse)?;
            (None, Some(build))
        } else if body.peek(kw::build) {
            let _ = body.parse::<kw::build>()?;
            let build = body.call(ExprBlock::parse)?;
            (Some(build), None)
        } else {
            return Err(body.error(format!("{} hasn't build block.", field.ident.unwrap())));
        };
        Ok(Self {
            metas,
            field,
            build,
            build_async,
            provides,
            dependency_type,
        })
    }
}
