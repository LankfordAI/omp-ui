{
  "targets": [
    {
      "target_name": "secret_service",
      "sources": ["secret_service.cc"],
      "cflags": ["<!@(pkg-config --cflags libsecret-1)", "-fexceptions"],
      "cflags_cc": ["<!@(pkg-config --cflags libsecret-1)", "-std=c++17", "-fexceptions"],
      "libraries": ["<!@(pkg-config --libs libsecret-1)"],
      "defines": ["NAPI_VERSION=8"]
    }
  ]
}
