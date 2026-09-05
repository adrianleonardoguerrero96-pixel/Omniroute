import test from "node:test";
import assert from "node:assert/strict";
import { OMNIROUTE_RESPONSE_HEADERS } from "../../src/shared/constants/headers.ts";
import { buildOmniRouteResponseMetaHeaders } from "../../src/domain/omnirouteResponseMeta.ts";
import { assembleStreamingResponseHeaders } from "../../open-sse/handlers/chatCore/streamingResponseHeaders.ts";                                   
import { buildNonStreamingResponseHeaders } from "../../open-sse/handlers/chatCore/nonStreamingResponseHeaders.ts";

test("headers constant exposes the fallback-attempts key", () => {
  assert.equal(
    OMNIROUTE_RESPONSE_HEADERS.fallbackAttempts,
    "X-OmniRoute-Fallback-Attempts"
  );
});

test("buildOmniRouteResponseMetaHeaders emits the fallback-attempts count when > 0", () => {
  const h = buildOmniRouteResponseMetaHeaders({ model: "gpt", provider: "openai", fallbackAttempts: 2 });
  assert.equal(h["X-OmniRoute-Fallback-Attempts"], "2");
});

test("buildOmniRouteResponseMetaHeaders omits the header when 0 / absent", () => {
  const none = buildOmniRouteResponseMetaHeaders({ model: "gpt" });
  assert.equal(none["X-OmniRoute-Fallback-Attempts"], undefined);
  const zero = buildOmniRouteResponseMetaHeaders({ model: "gpt", fallbackAttempts: 0 });
  assert.equal(zero["X-OmniRoute-Fallback-Attempts"], undefined);
});

test("assembleStreamingResponseHeaders includes X-OmniRoute-Fallback-Attempts on streaming responses when fallbackAttempts > 0", () => {                               
  const providerHeaders = new Headers();                                            
  const headers = assembleStreamingResponseHeaders({                                
    providerHeaders,                                                                
    provider: "openai",                                                             
    model: "gpt-4o",                                                                
    pendingRequestId: "req-stream-1",                                               
    comboStrategy: "priority",                                                      
    fallbackAttempts: 2,                                                            
  });                                                                               
  assert.equal(headers["X-OmniRoute-Fallback-Attempts"], "2");                      
});                                                                                 
                                                                                        
test("assembleStreamingResponseHeaders omits X-OmniRoute-Fallback-Attempts on streaming responses when fallbackAttempts is 0 or absent", () => {                    
  const providerHeaders = new Headers();                                            
  const headers = assembleStreamingResponseHeaders({                                
    providerHeaders,                                                                
    provider: "openai",                                                             
    model: "gpt-4o",                                                                
    pendingRequestId: "req-stream-2",                                               
    comboStrategy: "priority",                                                      
    fallbackAttempts: 0,                                                            
  });                                                                               
  assert.equal("X-OmniRoute-Fallback-Attempts" in headers, false);                  
});                                                                                 
                                                                                        
test("buildNonStreamingResponseHeaders includes X-OmniRoute-Fallback-Attempts on non-streaming responses when fallbackAttempts > 0", () => {                           
  const headers = buildNonStreamingResponseHeaders({                                
    provider: "openai",                                                             
    model: "gpt-4o",                                                                
    startTime: Date.now() - 50,                                                     
    responseUsage: null,                                                            
    estimatedCost: 0,                                                               
    requestId: "req-nonstream-1",                                                   
    comboStrategy: "priority",                                                      
    fallbackAttempts: 1,                                                            
  });                                                                               
  assert.equal(headers["X-OmniRoute-Fallback-Attempts"], "1");                      
});                                                                                 
                                                                                        
test("buildNonStreamingResponseHeaders omits X-OmniRoute-Fallback-Attempts on non-streaming responses when fallbackAttempts is 0 or absent", () => {                    
  const headers = buildNonStreamingResponseHeaders({                                
    provider: "openai",                                                             
    model: "gpt-4o",                                                                
    startTime: Date.now() - 50,                                                     
    responseUsage: null,                                                            
    estimatedCost: 0,                                                               
    requestId: "req-nonstream-2",                                                   
    comboStrategy: "priority",                                                      
    fallbackAttempts: 0,                                                            
  });                                                                               
  assert.equal("X-OmniRoute-Fallback-Attempts" in headers, false);                  
});