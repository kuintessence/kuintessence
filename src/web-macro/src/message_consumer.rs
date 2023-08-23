use proc_macro2::{Ident, Span};
use syn::{
    parse2, punctuated::Punctuated, token::Comma, FnArg, ItemFn, Lifetime, LifetimeDef, ReturnType,
    Type,
};

pub fn internal_message_consumer(
    _attr: proc_macro2::TokenStream,
    body: proc_macro2::TokenStream,
) -> proc_macro2::TokenStream {
    let body: ItemFn = match parse2(body) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };
    let (visibility, attrs, block) = (&body.vis, &body.attrs, &body.block);
    let mut sig = body.sig.clone();
    let mut old_sig = body.sig.clone();
    let inputs = sig.inputs.clone();
    let mut new_inputs = Punctuated::<FnArg, Comma>::new();
    let mut opt_inputs = Punctuated::<FnArg, Comma>::new();
    let mut serializable_inputs = Punctuated::<FnArg, Comma>::new();
    let content_input: FnArg = match parse2(quote::quote! {content: &'async_fn str}) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };
    let lifetime = Lifetime::new("'async_fn", Span::call_site());
    new_inputs.push(content_input);
    for input in inputs.iter() {
        match input {
            FnArg::Typed(x) => {
                if x.attrs.iter().any(|x| x.path.get_ident().unwrap().to_string().eq("serialize")) {
                    let mut x = x.clone();
                    x.attrs = vec![];
                    let out = FnArg::Typed(x);
                    serializable_inputs.push(out.clone());
                    opt_inputs.push(out);
                } else {
                    match x.ty.as_ref() {
                        Type::Reference(ty) => {
                            opt_inputs.push(FnArg::Typed(x.clone()));
                            let mut x = x.clone();
                            let mut ty = ty.clone();
                            ty.lifetime = Some(lifetime.clone());
                            x.ty = Box::new(Type::Reference(ty));
                            new_inputs.push(FnArg::Typed(x.clone()));
                        }
                        _ => {
                            opt_inputs.push(FnArg::Typed(x.clone()));
                            new_inputs.push(FnArg::Typed(x.clone()));
                        }
                    }
                }
            }
            _ => {
                new_inputs.push(input.clone());
                opt_inputs.push(input.clone());
            }
        }
    }
    sig.inputs = new_inputs;
    old_sig.inputs = opt_inputs;
    let header = if serializable_inputs.len() == 1 {
        let input = serializable_inputs.first();
        quote::quote! {
            let #input = serde_json::from_str(content).unwrap();
        }
    } else {
        let serializable_inputs = serializable_inputs.iter();
        quote::quote! {
            let (#(#serializable_inputs,)*) = serde_json::from_str(content).unwrap();
        }
    };
    sig.asyncness = None;
    sig.generics.params.push(syn::GenericParam::Lifetime(LifetimeDef::new(
        Lifetime::new("'async_fn", Span::call_site()),
    )));
    sig.output = match &sig.output {
        ReturnType::Default => ReturnType::Default,
        ReturnType::Type(x, _) => {
            let new_return_type: Type = match parse2(
                quote::quote! {std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + 'async_fn>>},
            ) {
                Ok(x) => x,
                Err(e) => return e.into_compile_error(),
            };
            ReturnType::Type(*x, Box::new(new_return_type))
        }
    };
    let ident = &old_sig.ident;
    let param_idents = &old_sig
        .inputs
        .iter()
        .filter_map(|x| match x {
            FnArg::Typed(x) => match x.pat.as_ref() {
                syn::Pat::Ident(x) => Some(x.ident.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect::<Vec<Ident>>();
    quote::quote! {
        #(#attrs)*
        #visibility #sig {
            #header
            #old_sig
            #block
            Box::pin(#ident(#(#param_idents,)*))
        }
    }
}
