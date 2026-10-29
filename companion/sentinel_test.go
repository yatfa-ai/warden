package main

import (
	"reflect"
	"testing"
)

// Branch-level pin of the Go half of the ___B_<key>___ / ___E_<key>___ framing
// contract (the JS twin is tested in src/companion.test.js).
//
// NOTE: the 7-char lines "___B___" / "___E___" are deliberately NOT in these
// tables: stripSentinel panics on them (overlapping prefix/suffix), which is a
// separate production bug, not a test gap.

func TestStripSentinel(t *testing.T) {
	cases := []struct {
		name, line, prefix, key string
		ok                      bool
	}{
		{"open", "___B_a___", "___B_", "a", true},
		{"close", "___E_p-worker___", "___E_", "p-worker", true},
		{"key with underscores", "___B_a_b___", "___B_", "a_b", true},
		{"empty key (8 chars) is content", "___B____", "___B_", "", false},
		{"no prefix", "xx___B_a___", "___B_", "", false},
		{"no suffix", "___B_a__", "___B_", "", false},
		{"wrong prefix", "___E_a___", "___B_", "", false},
		{"empty line", "", "___B_", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, ok := stripSentinel(c.line, c.prefix)
			if k != c.key || ok != c.ok {
				t.Fatalf("stripSentinel(%q,%q) = (%q,%v), want (%q,%v)", c.line, c.prefix, k, ok, c.key, c.ok)
			}
		})
	}
}

func TestParseCaptureSentinels(t *testing.T) {
	cases := []struct {
		name, in string
		want     map[string]string
	}{
		{"two blocks", "___B_a___\nline1\nline2\n___E_a___\n___B_b___\nonly\n___E_b___\n", map[string]string{"a": "line1\nline2", "b": "only"}},
		{"blank lines and indent kept", "___B_a___\n  indented\n\nblank-above\n___E_a___\n", map[string]string{"a": "  indented\n\nblank-above"}},
		{"empty block is empty string", "___B_a___\n___E_a___\n", map[string]string{"a": ""}},
		{"banner and trailing noise ignored", "Welcome to bash\n___B_a___\nhi\n___E_a___\ntrailing noise\n", map[string]string{"a": "hi"}},
		{"missing closer drops pane", "___B_a___\nnever closed\n", map[string]string{}},
		{"reopen resets buffer uncommitted", "___B_a___\nstale\n___B_b___\nfresh\n___E_b___\n", map[string]string{"b": "fresh"}},
		{"stray closer outside block ignored", "___E_x___\n___B_a___\nhi\n___E_a___\n___E_a___\n", map[string]string{"a": "hi"}},
		{"closer key not checked against opener", "___B_a___\nhi\n___E_zzz___\n", map[string]string{"a": "hi"}},
		{"empty-key sentinel is content", "___B_a___\n___B____\n___E_a___\n", map[string]string{"a": "___B____"}},
		{"empty-key closer is content", "___B_a___\n___E____\nz\n___E_a___\n", map[string]string{"a": "___E____\nz"}},
		{"empty stdout", "", map[string]string{}},
		{"duplicate key last wins", "___B_a___\n1\n___E_a___\n___B_a___\n2\n___E_a___\n", map[string]string{"a": "2"}},
		{"CRLF keeps CR so sentinel not matched", "___B_a___\r\nhi\r\n___E_a___\r\n", map[string]string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseCaptureSentinels(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("parseCaptureSentinels(%q) = %#v, want %#v", c.in, got, c.want)
			}
		})
	}
}
