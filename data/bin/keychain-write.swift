#!/usr/bin/env swift
import Foundation
import Security

guard CommandLine.arguments.count == 3 else {
  fputs("usage: keychain-write.swift <service> <account>\n", stderr)
  exit(64)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let data = FileHandle.standardInput.readDataToEndOfFile()

let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: service,
  kSecAttrAccount as String: account,
]

let update: [String: Any] = [
  kSecValueData as String: data,
]

let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
if status == errSecSuccess {
  exit(0)
}

if status == errSecItemNotFound {
  var add = query
  add[kSecValueData as String] = data
  let addStatus = SecItemAdd(add as CFDictionary, nil)
  if addStatus == errSecSuccess {
    exit(0)
  }
  fputs("SecItemAdd failed: \(addStatus)\n", stderr)
  exit(1)
}

fputs("SecItemUpdate failed: \(status)\n", stderr)
exit(1)
