#!/usr/bin/env python3
"""
Test script for Deno Supabase Edge Function bug fix verification.
Tests the lazy VAPID initialization fix that prevents boot crashes.
"""

import requests
import json
from typing import Dict, Any, Tuple

# ANSI color codes for output
GREEN = '\033[92m'
RED = '\033[91m'
YELLOW = '\033[93m'
BLUE = '\033[94m'
RESET = '\033[0m'

# Server instances
INSTANCE_A = "http://localhost:8787"  # VAPID_KEYS_JSON IS set
INSTANCE_B = "http://localhost:8788"  # VAPID_KEYS_JSON is MISSING

def print_test_header(test_num: int, description: str):
    """Print a formatted test header."""
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST {test_num}: {description}{RESET}")
    print(f"{BLUE}{'='*80}{RESET}")

def print_result(test_num: int, passed: bool, status_code: int, body: Any, expected: str):
    """Print test result with color coding."""
    status = f"{GREEN}PASS{RESET}" if passed else f"{RED}FAIL{RESET}"
    print(f"\n{status} - TEST {test_num}")
    print(f"  Status Code: {status_code}")
    print(f"  Response Body: {json.dumps(body) if isinstance(body, dict) else body}")
    print(f"  Expected: {expected}")

def make_request(method: str, url: str, body: Dict[str, Any] = None) -> Tuple[int, Any, Dict[str, str]]:
    """Make HTTP request and return status, body, and headers."""
    try:
        headers = {"Content-Type": "application/json"} if body is not None else {}
        
        if method == "POST":
            response = requests.post(url, json=body, headers=headers, timeout=10)
        elif method == "OPTIONS":
            response = requests.options(url, timeout=10)
        else:
            raise ValueError(f"Unsupported method: {method}")
        
        # Try to parse JSON response
        try:
            body_data = response.json()
        except (ValueError, requests.exceptions.JSONDecodeError):
            body_data = response.text
        
        return response.status_code, body_data, dict(response.headers)
    except Exception as e:
        return -1, {"error": str(e)}, {}

def check_for_boot_crash_indicators(body: Any) -> bool:
    """Check if response contains indicators of the old boot crash bug."""
    body_str = json.dumps(body) if isinstance(body, dict) else str(body)
    bad_indicators = [
        "is not valid JSON",
        "SyntaxError",
        '"undefined" is not valid JSON'
    ]
    return any(indicator in body_str for indicator in bad_indicators)

def run_tests():
    """Execute all 6 test cases."""
    results = []
    
    # TEST 1: Instance A, boot no longer crashes (regression proof)
    print_test_header(1, "Instance A - Boot no longer crashes (empty body)")
    status, body, headers = make_request("POST", INSTANCE_A, {})
    
    has_boot_crash = check_for_boot_crash_indicators(body)
    expected_status = 400
    expected_body = {"error": "Invalid or missing recipient"}
    
    passed = (
        status == expected_status and
        not has_boot_crash and
        body == expected_body
    )
    
    print_result(1, passed, status, body, f"HTTP 400 with {expected_body}")
    results.append(("TEST 1", passed, status, body))
    
    # TEST 2: Instance A, invalid recipient still validated
    print_test_header(2, "Instance A - Invalid recipient validation")
    status, body, headers = make_request("POST", INSTANCE_A, {"recipient": "nobody"})
    
    has_boot_crash = check_for_boot_crash_indicators(body)
    expected_status = 400
    expected_body = {"error": "Invalid or missing recipient"}
    
    passed = (
        status == expected_status and
        not has_boot_crash and
        body == expected_body
    )
    
    print_result(2, passed, status, body, f"HTTP 400 with {expected_body}")
    results.append(("TEST 2", passed, status, body))
    
    # TEST 3: Instance A, OPTIONS/CORS preflight
    print_test_header(3, "Instance A - OPTIONS/CORS preflight")
    status, body, headers = make_request("OPTIONS", INSTANCE_A)
    
    has_cors_header = "access-control-allow-origin" in {k.lower(): v for k, v in headers.items()}
    expected_status = 200
    
    passed = status == expected_status and has_cors_header
    
    print(f"\n{'PASS' if passed else 'FAIL'} - TEST 3")
    print(f"  Status Code: {status}")
    print(f"  Has CORS Header: {has_cors_header}")
    print(f"  Access-Control-Allow-Origin: {headers.get('Access-Control-Allow-Origin', 'NOT FOUND')}")
    print(f"  Expected: HTTP 200 with Access-Control-Allow-Origin header")
    results.append(("TEST 3", passed, status, f"CORS header present: {has_cors_header}"))
    
    # TEST 4: Instance A, valid recipient reaches config OK
    print_test_header(4, "Instance A - Valid recipient (no boot crash, no missing-secret error)")
    valid_body = {
        "sender": "faizan",
        "recipient": "habiba",
        "message_id": "a1",
        "text": "hi",
        "type": "text"
    }
    status, body, headers = make_request("POST", INSTANCE_A, valid_body)
    
    has_boot_crash = check_for_boot_crash_indicators(body)
    has_missing_secret = "Missing VAPID_KEYS_JSON" in str(body)
    
    # Acceptable: 500 with "Push delivery failed" (DB error) OR 200
    # FAIL: if contains boot crash indicators or missing secret message
    passed = not has_boot_crash and not has_missing_secret
    
    print_result(4, passed, status, body, 
                 "Should NOT contain 'is not valid JSON', 'SyntaxError', or 'Missing VAPID_KEYS_JSON'")
    results.append(("TEST 4", passed, status, body))
    
    # TEST 5: Instance B, missing secret returns a CLEAR message
    print_test_header(5, "Instance B - Missing secret returns clear message (THE FIX)")
    valid_body = {
        "sender": "faizan",
        "recipient": "habiba",
        "message_id": "b1",
        "text": "hi",
        "type": "text"
    }
    status, body, headers = make_request("POST", INSTANCE_B, valid_body)
    
    has_boot_crash = check_for_boot_crash_indicators(body)
    expected_status = 500
    expected_message = "Missing VAPID_KEYS_JSON secret. Add it in Supabase → Edge Functions → Secrets, then redeploy the function."
    has_clear_message = expected_message in str(body)
    
    passed = (
        status == expected_status and
        has_clear_message and
        not has_boot_crash
    )
    
    print_result(5, passed, status, body, 
                 f"HTTP 500 with clear message about missing VAPID_KEYS_JSON")
    results.append(("TEST 5", passed, status, body))
    
    # TEST 6: Instance B, invalid recipient still short-circuits before config
    print_test_header(6, "Instance B - Invalid recipient short-circuits (empty body)")
    status, body, headers = make_request("POST", INSTANCE_B, {})
    
    has_boot_crash = check_for_boot_crash_indicators(body)
    expected_status = 400
    expected_body = {"error": "Invalid or missing recipient"}
    
    passed = (
        status == expected_status and
        not has_boot_crash and
        body == expected_body
    )
    
    print_result(6, passed, status, body, f"HTTP 400 with {expected_body}")
    results.append(("TEST 6", passed, status, body))
    
    # Print summary table
    print(f"\n{BLUE}{'='*80}{RESET}")
    print(f"{BLUE}TEST SUMMARY{RESET}")
    print(f"{BLUE}{'='*80}{RESET}\n")
    
    print(f"{'TEST':<10} {'STATUS':<10} {'HTTP':<10} {'RESPONSE BODY':<50}")
    print("-" * 80)
    
    for test_name, passed, status_code, response_body in results:
        status_str = f"{GREEN}PASS{RESET}" if passed else f"{RED}FAIL{RESET}"
        body_str = json.dumps(response_body) if isinstance(response_body, dict) else str(response_body)
        body_str = body_str[:47] + "..." if len(body_str) > 50 else body_str
        print(f"{test_name:<10} {status_str:<20} {status_code:<10} {body_str:<50}")
    
    # Overall result
    all_passed = all(result[1] for result in results)
    print("\n" + "="*80)
    if all_passed:
        print(f"{GREEN}✓ ALL TESTS PASSED - BUG FIX VERIFIED{RESET}")
        print(f"{GREEN}The lazy VAPID initialization fix is working correctly.{RESET}")
    else:
        print(f"{RED}✗ SOME TESTS FAILED - BUG FIX NOT FULLY VERIFIED{RESET}")
        failed_tests = [r[0] for r in results if not r[1]]
        print(f"{RED}Failed tests: {', '.join(failed_tests)}{RESET}")
    print("="*80 + "\n")
    
    return all_passed

if __name__ == "__main__":
    print(f"\n{YELLOW}Starting Deno Edge Function Bug Fix Verification{RESET}")
    print(f"{YELLOW}Testing lazy VAPID initialization fix{RESET}\n")
    
    success = run_tests()
    exit(0 if success else 1)
