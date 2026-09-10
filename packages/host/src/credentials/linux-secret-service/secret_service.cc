// libsecret N-API addon for the host's DEK protector (issue #442 §10.3).
//
//   lookup(schemaName: string, attributes: Record<string, string>) -> Buffer | null
//   store(schemaName: string, label: string, attributes: Record<string, string>,
//         secret: Buffer) -> undefined
//
// Raw node_api.h on purpose: node-addon-api is not a dependency. Every attribute
// is a string; the schema is built per call from the attribute names, so the
// JS side owns the schema, not this file. Secret Service only — libsecret's
// binary password API, synchronous; the caller runs it on a Worker with a
// deadline because a locked keyring blocks here until the user answers.
// Errors (no session bus, SECRET_ERROR, ...) throw with libsecret's message.

#include <node_api.h>

#include <cstring>
#include <string>
#include <vector>

#include <glib.h>
#include <libsecret/secret.h>

namespace {

#define NAPI_CALL_OR_RETURN(env, call) \
  do {                                  \
    if ((call) != napi_ok) {            \
      ThrowPending(env, #call);         \
      return nullptr;                   \
    }                                   \
  } while (0)

void ThrowPending(napi_env env, const char* what) {
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (pending) return;
  std::string message = "secret_service: ";
  message += what;
  napi_throw_error(env, nullptr, message.c_str());
}

bool GetString(napi_env env, napi_value value, std::string* out) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  out->resize(length);
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, out->data(), length + 1, &copied) != napi_ok) return false;
  out->resize(copied);
  return true;
}

// Owns a GHashTable<gchar*, gchar*> of the JS object's string properties.
struct Attributes {
  GHashTable* table = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  std::vector<std::string> names;
  ~Attributes() { g_hash_table_unref(table); }
  Attributes(const Attributes&) = delete;
  Attributes& operator=(const Attributes&) = delete;
  Attributes() = default;
};

bool ReadAttributes(napi_env env, napi_value object, Attributes* out) {
  napi_valuetype type;
  if (napi_typeof(env, object, &type) != napi_ok || type != napi_object) return false;
  napi_value keys;
  if (napi_get_property_names(env, object, &keys) != napi_ok) return false;
  uint32_t count = 0;
  if (napi_get_array_length(env, keys, &count) != napi_ok) return false;
  for (uint32_t i = 0; i < count; i++) {
    napi_value key;
    napi_value value;
    std::string name;
    std::string text;
    if (napi_get_element(env, keys, i, &key) != napi_ok || !GetString(env, key, &name)) return false;
    if (napi_get_property(env, object, key, &value) != napi_ok || !GetString(env, value, &text)) return false;
    g_hash_table_insert(out->table, g_strdup(name.c_str()), g_strdup(text.c_str()));
    out->names.push_back(name);
  }
  return true;
}

// A schema whose attributes are exactly the given names, all strings.
SecretSchema* NewSchema(const std::string& name, const std::vector<std::string>& attribute_names) {
  GHashTable* types = g_hash_table_new(g_str_hash, g_str_equal);
  for (const std::string& attribute : attribute_names) {
    g_hash_table_insert(types, const_cast<char*>(attribute.c_str()),
                        GINT_TO_POINTER(SECRET_SCHEMA_ATTRIBUTE_STRING));
  }
  SecretSchema* schema = secret_schema_newv(name.c_str(), SECRET_SCHEMA_NONE, types);
  g_hash_table_unref(types);
  return schema;
}

napi_value ThrowGError(napi_env env, GError* error) {
  napi_throw_error(env, nullptr, error->message != nullptr ? error->message : "unknown libsecret error");
  g_error_free(error);
  return nullptr;
}

napi_value ThrowUsage(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

napi_value Lookup(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  NAPI_CALL_OR_RETURN(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  std::string schema_name;
  Attributes attributes;
  if (argc < 2 || !GetString(env, argv[0], &schema_name) || !ReadAttributes(env, argv[1], &attributes)) {
    return ThrowUsage(env, "lookup(schemaName: string, attributes: Record<string, string>)");
  }

  SecretSchema* schema = NewSchema(schema_name, attributes.names);
  GError* error = nullptr;
  SecretValue* value = secret_password_lookupv_binary_sync(schema, attributes.table, nullptr, &error);
  secret_schema_unref(schema);
  if (error != nullptr) return ThrowGError(env, error);

  napi_value result;
  if (value == nullptr) {
    NAPI_CALL_OR_RETURN(env, napi_get_null(env, &result));
    return result;
  }
  gsize length = 0;
  const gchar* bytes = secret_value_get(value, &length);
  void* copy = nullptr;
  napi_status status = napi_create_buffer_copy(env, length, bytes, &copy, &result);
  secret_value_unref(value);
  if (status != napi_ok) {
    ThrowPending(env, "napi_create_buffer_copy");
    return nullptr;
  }
  return result;
}

napi_value Store(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4];
  NAPI_CALL_OR_RETURN(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  std::string schema_name;
  std::string label;
  Attributes attributes;
  bool is_buffer = false;
  if (argc < 4 || !GetString(env, argv[0], &schema_name) || !GetString(env, argv[1], &label) ||
      !ReadAttributes(env, argv[2], &attributes) || napi_is_buffer(env, argv[3], &is_buffer) != napi_ok ||
      !is_buffer) {
    return ThrowUsage(
        env, "store(schemaName: string, label: string, attributes: Record<string, string>, secret: Buffer)");
  }
  void* data = nullptr;
  size_t length = 0;
  NAPI_CALL_OR_RETURN(env, napi_get_buffer_info(env, argv[3], &data, &length));

  // Content type is opaque bytes: the DEK is not text and must round-trip
  // without a trailing NUL or any charset guess.
  SecretValue* value = secret_value_new(static_cast<const gchar*>(data), static_cast<gssize>(length),
                                        "application/octet-stream");
  SecretSchema* schema = NewSchema(schema_name, attributes.names);
  GError* error = nullptr;
  gboolean ok = secret_password_storev_binary_sync(schema, attributes.table, SECRET_COLLECTION_DEFAULT,
                                                   label.c_str(), value, nullptr, &error);
  secret_schema_unref(schema);
  secret_value_unref(value);
  if (error != nullptr) return ThrowGError(env, error);
  if (!ok) {
    napi_throw_error(env, nullptr, "secret service refused to store the item");
    return nullptr;
  }
  napi_value undefined;
  NAPI_CALL_OR_RETURN(env, napi_get_undefined(env, &undefined));
  return undefined;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
      {"lookup", nullptr, Lookup, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"store", nullptr, Store, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  NAPI_CALL_OR_RETURN(env, napi_define_properties(env, exports, 2, descriptors));
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
