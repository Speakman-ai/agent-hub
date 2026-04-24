package cmd

import "testing"

func TestHelloDefault(t *testing.T) {
	got := Hello("")
	want := "Hello, world!"
	if got != want {
		t.Fatalf("Hello(\"\") = %q, want %q", got, want)
	}
}

func TestHelloNamed(t *testing.T) {
	got := Hello("agent")
	want := "Hello, agent!"
	if got != want {
		t.Fatalf("Hello(\"agent\") = %q, want %q", got, want)
	}
}
