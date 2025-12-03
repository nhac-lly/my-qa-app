"use client";

import { useState } from "react";
import { useAssistantForm } from "@assistant-ui/react-hook-form";
import { Form } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { callMCPTool } from "@/lib/mcpclient2";

const SetFormFieldTool = () => {
  return (
    <p className="text-center font-mono text-sm font-bold text-blue-500">
      set_form_field(...)
    </p>
  );
};

const SubmitFormTool = () => {
  return (
    <p className="text-center font-mono text-sm font-bold text-blue-500">
      submit_form(...)
    </p>
  );
};

interface RegistrationFormProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onResult?: (result: any) => void;
}

export function RegistrationForm({ onResult }: RegistrationFormProps = {}) {
  const form = useAssistantForm({
    defaultValues: {
      email: "",
      password: "",
      firstName: "",
      lastName: "",
      title: "Mr" as "Mr" | "Mrs",
      phone: "",
      national: "US",
    },
    assistant: {
      tools: {
        set_form_field: {
          render: SetFormFieldTool,
        },
        submit_form: {
          render: SubmitFormTool,
        },
      },
    },
  });


  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [registrationResult, setRegistrationResult] = useState<any>(null);

  type FormValues = {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    title: "Mr" | "Mrs";
    phone: string;
    national: string;
  };

  const onSubmit = async (values: FormValues) => {
    try {
      setIsSubmitting(true);
      setSubmitError(null);
      
      const result = await callMCPTool("register-new-user-account", {
        email: values.email,
        password: values.password,
        firstName: values.firstName,
        lastName: values.lastName,
        title: values.title,
        phone: values.phone,
        national: values.national,
      });
      
      console.log("Registration result:", result);
      
      // Check if result indicates an error
      const isError = result && typeof result === "object" && "isError" in result && result.isError === true;
      
      setRegistrationResult(result);
      setIsSubmitted(true);
      
      // If there's an error, also set it in submitError
      if (isError && result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
        const content = result.content[0];
        if (content && typeof content === "object" && "text" in content && typeof content.text === "string") {
          try {
            const parsed = JSON.parse(content.text);
            if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
              setSubmitError(parsed.error);
            }
          } catch {
            // If parsing fails, use the raw text
            setSubmitError(content.text);
          }
        }
      }
      
      // Pass result back to parent component (RegistrationToolUI)
      if (onResult) {
        onResult(result);
      }
    } catch (error) {
      console.error("Registration error:", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to register account";
      setSubmitError(errorMessage);
      
      // Error is stored locally and will be displayed in the form
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitting) {
    return (
      <div className="my-4 p-4 border rounded-lg bg-blue-50 dark:bg-blue-900/20">
        <p className="font-bold text-blue-600 dark:text-blue-400">
          Registering account...
        </p>
      </div>
    );
  }

  if (isSubmitted && registrationResult) {
    // Check if result indicates an error
    const isError = registrationResult && typeof registrationResult === "object" && "isError" in registrationResult && registrationResult.isError === true;
    
    // Parse the result if it has content array (MCP response format)
    let parsedResult = null;
    let errorMessage: string | null = null;
    
    if (registrationResult && typeof registrationResult === "object" && "content" in registrationResult) {
      const content = registrationResult.content?.[0];
      if (content?.text) {
        try {
          parsedResult = JSON.parse(content.text);
          // Check if parsed result contains an error message
          if (parsedResult && typeof parsedResult === "object" && "error" in parsedResult) {
            errorMessage = parsedResult.error;
          }
        } catch {
          // Not JSON, treat text as error message if isError is true
          if (isError) {
            errorMessage = content.text;
          }
        }
      }
    }

    // Display error if result indicates an error
    if (isError) {
      return (
        <div className="my-4 p-4 border border-red-500 rounded-lg bg-red-50 dark:bg-red-900/20">
          <p className="font-bold text-red-600 dark:text-red-400 mb-2">
            Registration Failed
          </p>
          <p className="text-sm text-red-700 dark:text-red-300">
            {errorMessage || "An error occurred while creating your account. Please check your information and try again."}
          </p>
        </div>
      );
    }

    // Check for success
    if (parsedResult?.isSucceeded) {
      return (
        <div className="my-4 p-4 border rounded-lg bg-green-50 dark:bg-green-900/20">
          <p className="font-bold text-green-600 dark:text-green-400 mb-2">
            Account created successfully!
          </p>
          {parsedResult.data?.profile && (
            <div className="mt-2 text-sm text-green-700 dark:text-green-300">
              <p>Email: {parsedResult.data.profile.email}</p>
              <p>Name: {parsedResult.data.profile.fullName}</p>
              <p className="mt-2 text-xs">
                Please check your email for the OTP verification code.
              </p>
            </div>
          )}
        </div>
      );
    }

    // Generic success message (if no explicit error or success flag)
    return (
      <div className="my-4 p-4 border rounded-lg bg-green-50 dark:bg-green-900/20">
        <p className="font-bold text-green-600 dark:text-green-400">
          Account created successfully! Please check your email for the OTP verification code.
        </p>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4 my-4 p-4 border rounded-lg bg-background"
      >
        <h3 className="text-lg font-semibold mb-4">Create Arobid Account</h3>

        {submitError && (
          <div className="p-3 border border-red-500 rounded bg-red-50 dark:bg-red-900/20">
            <p className="text-sm text-red-600 dark:text-red-400">
              {submitError}
            </p>
          </div>
        )}

        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormDescription>Your email address</FormDescription>
              <FormControl>
                <Input
                  type="email"
                  placeholder="email@example.com"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormDescription>
                6-20 characters, must include uppercase, lowercase, numbers, and
                special characters
              </FormDescription>
              <FormControl>
                <Input type="password" placeholder="Password" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>First Name</FormLabel>
                <FormControl>
                  <Input placeholder="First Name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="lastName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Last Name</FormLabel>
                <FormControl>
                  <Input placeholder="Last Name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl>
                  <select
                    {...field}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  >
                    <option value="Mr">Mr</option>
                    <option value="Mrs">Mrs</option>
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="national"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Nationality Code</FormLabel>
                <FormDescription>2-letter country code (e.g., US, VN)</FormDescription>
                <FormControl>
                  <Input
                    placeholder="US"
                    maxLength={2}
                    {...field}
                    onChange={(e) => {
                      field.onChange(e.target.value.toUpperCase());
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone Number</FormLabel>
              <FormDescription>Vietnamese or international format</FormDescription>
              <FormControl>
                <Input 
                  type="tel" 
                  placeholder="+11234567890" 
                  {...field}
                  pattern="(\+84[0-9]{9,10}|\+[0-9]{10,15}|0[0-9]{9,10})"
                  title="Vietnamese (+84XXXXXXXXX or 0XXXXXXXXX) or international (+XXXXXXXXXXX)"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full">
          Create Account
        </Button>
      </form>
    </Form>
  );
}

