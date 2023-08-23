use syn::{parse2, FnArg, ItemFn};

pub fn internal_http_request(
    _attr: proc_macro2::TokenStream,
    body: proc_macro2::TokenStream,
) -> proc_macro2::TokenStream {
    let body: ItemFn = match parse2(body) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };
    let (visibility, attrs, block) = (&body.vis, &body.attrs, &body.block.stmts);
    let mut sig = body.sig.clone();
    let new_input: FnArg = match parse2(quote::quote! {raw_req: ::actix_web::HttpRequest}) {
        Ok(x) => x,
        Err(e) => return e.into_compile_error(),
    };
    sig.inputs.push(new_input);
    quote::quote! {
        #(#attrs)*
        #visibility #sig {
            #(#block)*
        }
    }
}
